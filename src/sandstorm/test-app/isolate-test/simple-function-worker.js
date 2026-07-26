export default async function fetch(request, env, ctx) {
  ctx.waitUntil(Promise.resolve());
  const url = new URL(request.url);
  return Response.json({
    ok: true,
    style: "function",
    pathname: url.pathname,
    hasEnv: typeof env === "object",
  });
}
