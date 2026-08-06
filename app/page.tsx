import { headers } from "next/headers";
import ClearInboxApp, { type ClearInboxView } from "./clear-inbox-app";

const views = new Set<ClearInboxView>(["triage", "approvals", "drafts", "audit", "automation"]);

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; message?: string }>;
}) {
  const requestHeaders = await headers();
  const params = await searchParams;
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const initialView = views.has(params.view as ClearInboxView)
    ? (params.view as ClearInboxView)
    : "triage";

  return (
    <ClearInboxApp
      displayName={fullName ?? email}
      initialView={initialView}
      initialMessageId={params.message}
    />
  );
}
