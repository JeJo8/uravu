import { defineConfig } from "vite";

// /login, /signup and /join/<token> are all served by auth.html.
// Render does the same with the `routes` in render.yaml.
function authRoutes(req, res, next) {
  const [path, query] = req.url.split("?");
  if (/^\/(login|signup)\/?$/.test(path) || path.startsWith("/join/")) {
    req.url = "/auth.html" + (query ? `?${query}` : "");
  }
  next();
}

export default defineConfig({
  build: {
    rollupOptions: { input: { main: "index.html", auth: "auth.html" } },
  },
  plugins: [{
    name: "auth-routes",
    configureServer(server) { server.middlewares.use(authRoutes); },
    configurePreviewServer(server) { server.middlewares.use(authRoutes); },
  }],
});
