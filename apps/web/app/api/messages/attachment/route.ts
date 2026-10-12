import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import { attachmentQuery } from "@/app/api/messages/validation";
import { getAttachmentDownloadHeaders } from "./download-headers";

export const GET = withEmailProvider("messages/attachment", async (request) => {
  const { emailProvider } = request;

  const { searchParams } = new URL(request.url);

  const query = attachmentQuery.parse({
    messageId: searchParams.get("messageId"),
    attachmentId: searchParams.get("attachmentId"),
    mimeType: searchParams.get("mimeType"),
    filename: searchParams.get("filename"),
  });

  const attachmentData = await emailProvider.getAttachment(
    query.messageId,
    query.attachmentId,
  );

  if (!attachmentData.data) {
    return NextResponse.json({ error: "No data" }, { status: 404 });
  }

  const decodedData = Buffer.from(attachmentData.data, "base64");

  return new NextResponse(decodedData, {
    headers: getAttachmentDownloadHeaders(query.filename),
  });
});
