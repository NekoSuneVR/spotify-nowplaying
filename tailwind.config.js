/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app.js',
    './public/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        neko: {
          bg: '#050807',
          panel: '#0b1410',
          panelStrong: '#101d17',
          line: 'rgba(187, 247, 208, 0.16)',
          green: '#1ed760',
          mint: '#8ff7b2',
          cyan: '#6ee7f9',
        },
      },
      boxShadow: {
        glow: '0 0 48px rgba(30, 215, 96, 0.16)',
        panel: '0 22px 80px rgba(0, 0, 0, 0.35)',
      },
    },
  },
  plugins: [],
};
