/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        kukla: {
          green: '#0e7b5a',
          'green-alt': '#0c6b4f',
          mint: '#eefaf5',
          border: '#d8e3df',
          page: '#f7f8f8',
        },
      },
      boxShadow: {
        card: '0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04)',
      },
    },
  },
  plugins: [],
};
