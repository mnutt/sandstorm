export default {
  style: "object",

  async fetch(request, env, ctx) {
    ctx.waitUntil(Promise.resolve());
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      style: this.style,
      pathname: url.pathname,
      hasEnv: typeof env === "object",
    });
  },
};
