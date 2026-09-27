import { NextResponse } from "next/server";

export const privateResponse = <ResponseType extends NextResponse>(response: ResponseType): ResponseType => {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
};

export const privateJsonResponse = (body: unknown, status: number): NextResponse =>
  privateResponse(NextResponse.json(body, { status }));
