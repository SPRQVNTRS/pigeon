import { execSync } from 'node:child_process';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

function getGitHash(): string {
  if (process.env.BUILD_HASH) return process.env.BUILD_HASH;
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '');
  const hmrPort = env.HMR_PORT ? parseInt(env.HMR_PORT, 10) : 24678;
  const serverPort = env.PORT ? parseInt(env.PORT, 10) : 3601;

  return {
    plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
    define: {
      __BUILD_HASH__: JSON.stringify(getGitHash()),
    },
    server: {
      port: serverPort,
      hmr: { port: hmrPort },
    },
  };
});
