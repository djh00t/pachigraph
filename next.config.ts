import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: [
    'pg',
    '@aws-sdk/client-s3',
    '@modelcontextprotocol/sdk',
    'jose',
    'zod',
  ],
};

export default nextConfig;
