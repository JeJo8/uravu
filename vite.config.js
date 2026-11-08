import { defineConfig, loadEnv } from "vite";

// /login, /signup and /join/<token> are all served by auth.html.
// Render does the same with the `routes` in render.yaml.
function authRoutes(req, res, next) {
  const [path, query] = req.url.split("?");
  if (/^\/(login|signup)\/?$/.test(path) || path.startsWith("/join/")) {
    req.url = "/auth.html" + (query ? `?${query}` : "");
  }
  next();
}

// /api/auth/* -> Neon Auth, so the sign-in cookie belongs to this site (see src/neon.js).
function authProxy(authUrl) {
  if (!authUrl) return undefined;
  const u = new URL(authUrl);
  return {
    "/api/auth": {
      target: u.origin,
      changeOrigin: true,
      rewrite: path => path.replace(/^\/api\/auth/, u.pathname.replace(/\/$/, "")),
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const proxy = authProxy(env.VITE_NEON_AUTH_URL);
  return {
  server: { proxy },
  preview: { proxy },
  build: {
    rollupOptions: { input: { main: "index.html", auth: "auth.html" } },
  },
  plugins: [{
    name: "auth-routes",
    configureServer(server) { server.middlewares.use(authRoutes); },
    configurePreviewServer(server) { server.middlewares.use(authRoutes); },
  }],
};
});
