/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // ★ 关键：关闭 preflight，避免与 MUI CssBaseline 的全局重置互相打架
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#2563EB',
          deep: '#1E3A8A',
        },
      },
    },
  },
  plugins: [],
};
