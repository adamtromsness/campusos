/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@campusos/shared'],
  output: 'standalone',
};

module.exports = nextConfig;
