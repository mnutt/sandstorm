export default function helloFetch(request) {
    const url = new URL(request.url);
    return Response.json({
      ok: true,
      message: "hello from an isolate grain",
      method: request.method,
      pathname: url.pathname,
      hasAmbientPlatformBindings: false,
    });
}
