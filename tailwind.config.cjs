const dynamicThemeColors = ['blue', 'orange', 'amber', 'emerald', 'indigo', 'rose'];

const dynamicThemeColorClasses = dynamicThemeColors.flatMap((color) => [
  `bg-${color}-50`,
  `bg-${color}-600`,
  `hover:bg-${color}-50`,
  `hover:bg-${color}-700`,
  `text-${color}-600`,
  `hover:text-${color}-600`,
  `group-hover:text-${color}-600`,
  `text-${color}-400`,
  `border-${color}-500`,
  `hover:border-${color}-600`,
  `focus:border-${color}-500`,
  `focus:ring-${color}-500/20`,
  `shadow-${color}-500/20`,
  `dark:bg-${color}-900/20`,
  `dark:text-${color}-400`,
]);

// Local Edition：配色改为读取 local/bansho-theme.css 里的 CSS 变量（万象之匣风格）。
const themedScale = (name) => Object.fromEntries(
  ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']
    .map((step) => [step, `rgb(var(--rf-${name}-${step}) / <alpha-value>)`]),
);

module.exports = {
  content: [
    './index.html',
    './{components,constants,hooks,services,utils,views}/**/*.{ts,tsx}',
    './App.tsx',
    './index.tsx',
  ],
  darkMode: 'class',
  safelist: dynamicThemeColorClasses,
  theme: {
    extend: {
      colors: {
        gray: themedScale('gray'),
        slate: themedScale('slate'),
        emerald: themedScale('emerald'),
        teal: themedScale('teal'),
        green: themedScale('green'),
        primary: '#2F5C4B',
        'primary-dark': '#264C3E',
        'background-light': '#F6F4EE',
        'background-dark': '#111827',
        'surface-light': '#FFFFFF',
        'surface-dark': '#1F2937',
        'border-light': '#E5E7EB',
        'border-dark': '#374151',
      },
      fontFamily: {
        display: ['Noto Sans SC', 'Inter', 'sans-serif'],
        body: ['Noto Sans SC', 'Inter', 'sans-serif'],
        serif: ['Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', 'serif'],
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
    require('@tailwindcss/container-queries'),
  ],
};
