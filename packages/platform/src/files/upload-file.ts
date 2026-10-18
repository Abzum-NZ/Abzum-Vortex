import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fieldIdSchema, platformIdSchema, sessionContextSchema, applicationRootIdSchema,
  type RecordTypeId, type RecordId, type FieldId, type FileId } from "../schema";
import type { RequestDatabaseTransaction } from "../db/index";
import { resolveEffectiveCapabilityPolicy, reserveCapabilityQuantity, consumeCapabilityReservation, releaseCapabilityReservation } from "../access/index";
import { createSqlFileUploadRepository } from "./upload-repository";
import { createFileUploadCoordinator, createUploadStorageAuthorityResolver, type UploadAttachmentSettings } from "./upload";
import { createStorageCredentialBridge, type StorageKeyDefinition } from "./storage-credentials";
import { createStoredUploadInspection, type FileScannerConfiguration } from "./upload-inspection";
import { resolveFileStorageDestination, type FileStorageDestination } from "./storage-destination";

const settingsSchema = z.object({allowedKinds:z.array(z.enum(["image","document","spreadsheet","presentation","audio","video","archive","text","other"])),
  allowedExtensions:z.array(z.string()).optional(),maxFileSizeMb:z.number().positive(),multiple:z.boolean(),maxFiles:z.number().int().optional()}).strict();
const authoritySchema = z.discriminatedUnion("outcome",[
  z.object({outcome:z.literal("refused")}).strict(),
  z.object({outcome:z.literal("allowed"),sessionContext:sessionContextSchema,attachmentSettings:settingsSchema,
    readableFieldIds:z.array(fieldIdSchema),changeableFieldIds:z.array(fieldIdSchema),existingAttachmentCount:z.number().int().nonnegative()}).strict(),
]);
export type AttachmentUploadResult = Readonly<{outcome:"completed";fileId:FileId;name:string}> | Readonly<{outcome:"refused";message:string}>;

/** One bounded request uploads, inspects and scans; only the record save can attach its result. */
export const uploadAttachmentFile = async (
  transaction:RequestDatabaseTransaction,
  input:Readonly<{recordTypeId:RecordTypeId;recordId?:RecordId;fieldId:FieldId;replacingFileId?:FileId;filename:string;mediaType:string;bytes:Uint8Array}>,
  configuration:Readonly<{destination:FileStorageDestination;key:StorageKeyDefinition;scanner:FileScannerConfiguration}>,
):Promise<AttachmentUploadResult>=>{
  const rows=await transaction.query<{result:unknown}>`select vortex_platform.read_attachment_upload_authority(${input.recordTypeId}::uuid,${input.recordId??null}::uuid,${input.fieldId}::uuid) as result`;
  if(rows.length!==1) throw new Error("UPLOAD_AUTHORITY_RESULT_INVALID");
  const authority=authoritySchema.parse(rows[0]?.result);
  if(authority.outcome!=="allowed") return {outcome:"refused",message:"You cannot add a file to this field. Refresh the page and try again."};
  const context=authority.sessionContext;
  const entitlement={tenantId:context.tenantId,organizationId:context.organizationId,capabilityKey:"platform.file_upload",unit:"bytes",requestedQuantity:Math.max(1,input.bytes.byteLength),correlationId:context.correlationId};
  const policy=await resolveEffectiveCapabilityPolicy(transaction,entitlement);
  if(policy.outcome!=="available") return {outcome:"refused",message:"File storage has not been enabled for your organisation. Ask an administrator."};
  const reservation=await reserveCapabilityQuantity(transaction,{policy,requestedQuantity:entitlement.requestedQuantity,duplicateKey:platformIdSchema.parse(randomUUID())});
  const repository=createSqlFileUploadRepository(transaction);
  const bridge=createStorageCredentialBridge({destination:configuration.destination,activeKeyId:configuration.key.keyId,keys:[configuration.key],resolveCurrentAuthority:createUploadStorageAuthorityResolver(repository)});
  const inspection=createStoredUploadInspection({bridge,destination:configuration.destination,scanner:configuration.scanner,maximumBytes:entitlement.requestedQuantity});
  const coordinator=createFileUploadCoordinator({repository,bridge,...inspection});
  const current={sessionContext:context,recordTypeId:input.recordTypeId,...(input.recordId===undefined?{}:{recordId:input.recordId}),readableFieldIds:authority.readableFieldIds,changeableFieldIds:authority.changeableFieldIds};
  const admitted=await coordinator.admitUpload({...current,organizationId:context.organizationId,applicationRootId:applicationRootIdSchema.parse(context.applicationRootId),fieldId:input.fieldId,
    attachmentSettings:authority.attachmentSettings as UploadAttachmentSettings,existingAttachmentCount:authority.existingAttachmentCount,
    ...(input.replacingFileId===undefined?{}:{replacingFileId:input.replacingFileId}),rawFilename:input.filename,claimedSizeBytes:input.bytes.byteLength,claimedMediaType:input.mediaType,
    capability:{request:{entitlement,policy:{capabilityKey:policy.capabilityKey,unit:policy.unit,policyId:policy.policyId,policyRevision:policy.policyRevision,assignmentId:policy.assignmentId,assignmentRevision:policy.assignmentRevision,appliedScope:policy.appliedScope}},reservation,ports:{consumeReservation:command=>consumeCapabilityReservation(transaction,command),releaseReservation:command=>releaseCapabilityReservation(transaction,command)}}});
  if(admitted.outcome!=="admitted") return {outcome:"refused",message:admitted.reason==="capability_refused"?"Your organisation has no file storage space remaining.":admitted.message};
  const grant=admitted.browserUploadGrant;
  const stored=await fetch(`${resolveFileStorageDestination(configuration.destination).origin}/storage/v1/object/${grant.bucketId}/${grant.objectPath.split("/").map(encodeURIComponent).join("/")}`,{
    method:"POST",headers:{Authorization:`Bearer ${grant.token}`,"Content-Type":input.mediaType||"application/octet-stream","x-upsert":"false"},body:Buffer.from(input.bytes),redirect:"error",signal:AbortSignal.timeout(60_000)});
  if(!stored.ok){await stored.body?.cancel();throw new Error(`UPLOAD_STORAGE_REFUSED_${stored.status}`);}
  await stored.body?.cancel();
  const complete=await coordinator.completeUpload({...current,fileId:admitted.fileId,attachmentSettings:authority.attachmentSettings as UploadAttachmentSettings});
  if(complete.outcome!=="scanned") return {outcome:"refused",message:complete.outcome==="quarantined"?"This file could not pass the file safety check. Choose another file.":complete.message};
  return {outcome:"completed",fileId:complete.fileRecord.fileId,name:complete.fileRecord.originalSafeDisplayName};
};
