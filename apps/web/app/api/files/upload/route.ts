import type { NextRequest } from "next/server";
import { z } from "zod";
import { recordTypeIdSchema, recordIdSchema, fieldIdSchema, fileIdSchema, logRefusal } from "@vortex/platform/schema";
import { uploadAttachmentFile } from "@vortex/platform/server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { humanOrganizationRequests } from "../../../_lib/server-composition";
import { fileStorageSigningConfiguration, fileScannerConfiguration } from "../../../_lib/server-configuration";
import { getIdentityJourneyConfiguration } from "../../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { privateJsonResponse } from "../../../_lib/private-response";
import { readBoundedRequestBytes } from "../../_lib/bounded-request-body";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const selectorSchema=z.object({tenantShortName:z.string().min(1).max(200),organizationShortName:z.string().min(1).max(200),applicationKey:z.string().min(1).max(200),pageKey:z.string().min(1).max(200),
  recordTypeId:recordTypeIdSchema,recordId:recordIdSchema.optional(),fieldId:fieldIdSchema,replacingFileId:fileIdSchema.optional(),filename:z.string().min(1).max(255)}).strict();
const refuse=(code:string,status=403,cause?:unknown)=>{
  logRefusal("files","upload",code,cause);
  return privateJsonResponse({outcome:"refused",message:"The file could not be uploaded. Refresh the page and try again."},status);
};
export async function POST(request:NextRequest){
  try{
    const configuration=getIdentityJourneyConfiguration();
    if(request.headers.get("origin")!==new URL(configuration.siteUrl).origin) return refuse("origin_refused");
    const identity=await resolveIdentitySession();
    if(identity.kind!=="active") return refuse("identity_not_active",401);
    const selectors=selectorSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if(!selectors.success) return refuse("selectors_invalid",400,selectors.error);
    const input=selectors.data;
    const address=await resolveApplicationAddress(identity.session,input.tenantShortName,input.organizationShortName,input.applicationKey,input.pageKey);
    if(address.kind!=="application_page") return refuse("page_refused");
    const bytes=await readBoundedRequestBytes(request,50*1024*1024);
    if(bytes.kind!=="read") return refuse(`body_${bytes.kind}`,bytes.kind==="too_large"?413:400);
    const signing=fileStorageSigningConfiguration(configuration.supabaseUrl);
    const result=await humanOrganizationRequests().run(identity.session,{organizationId:address.read.organizationId,applicationRootId:address.application.applicationRootId},
      transaction=>uploadAttachmentFile(transaction,{...input,bytes:bytes.bytes,mediaType:request.headers.get("content-type")??"application/octet-stream"},
        {destination:signing.destination,key:{keyId:signing.keyId,signer:signing.privateKey},scanner:fileScannerConfiguration()}));
    if(result.kind!=="available") return refuse(`protected_${result.kind}`);
    if(result.value.outcome==="refused") logRefusal("files","upload","upload_refused");
    return privateJsonResponse(result.value,result.value.outcome==="completed"?200:422);
  }catch(error){return refuse("upload_unavailable",503,error);}
}
