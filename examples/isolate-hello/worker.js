export default {
  fetch(request, env) {
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      message: "hello from an isolate grain",
      method: request.method,
      pathname: url.pathname,
      hasStorageBinding: Boolean(env.STORAGE),
      hasPowerboxBinding: Boolean(env.POWERBOX),
    });
  },
};
