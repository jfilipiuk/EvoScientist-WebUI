import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the npm package (the bin launcher runs
  // dist/server.js). Needed because /api/skills is a server route.
  output: "standalone",
};

export default nextConfig;
