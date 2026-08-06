export async function GET() {
  return Response.json({
    service: "clearinbox",
    status: "ok",
    mode: "simulation",
  });
}
