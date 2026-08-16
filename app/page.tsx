import { headers } from "next/headers";
import SecureWorkspace from "./secure-workspace";

function decodeDisplayName(value: string | null, encoding: string | null) {
  if (!value || encoding !== "percent-encoded-utf-8") return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const displayName = decodeDisplayName(
    requestHeaders.get("oai-authenticated-user-full-name"),
    requestHeaders.get("oai-authenticated-user-full-name-encoding"),
  );

  return <SecureWorkspace initialDisplayName={displayName ?? email} />;
}
