const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: { unoptimized: true },
  // Prevent malformed server chunks on this environment during build.
  swcMinify: false,
  webpack: (config) => {
    if (process.env.MF_BUILD_ISOLATE_A === '1') {
      config.resolve.alias['@supabase/supabase-js'] = path.resolve(__dirname, 'lib/testing/build-stubs/supabase-js-stub.ts');
    }
    return config;
  },
};

module.exports = nextConfig;
