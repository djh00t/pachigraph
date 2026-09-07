import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Bundle the MCP SDK so its transitive dependencies ship in standalone output.
  serverExternalPackages: ['pg', '@aws-sdk/client-s3', 'jose', 'zod'],
};

export default nextConfig;
