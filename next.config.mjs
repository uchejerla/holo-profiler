/** @type {import('next').NextConfig} */
const nextConfig = {
  // snowflake-sdk and the AWS SDK load optional native/dynamic modules; keep them out of the server bundle.
  serverExternalPackages: ['snowflake-sdk', '@aws-sdk/client-s3'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ] }];
  },
};
export default nextConfig;
