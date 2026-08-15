/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#14213D",
          light: "#1C2D4F",
          lighter: "#263A61",
        },
        paper: {
          DEFAULT: "#EDE6D6",
          dark: "#DDD3BC",
        },
        cream: "#F3EFE3",
        rust: {
          DEFAULT: "#B5432F",
          dark: "#8A3122",
        },
        forest: {
          DEFAULT: "#2F6F4E",
          dark: "#21503A",
        },
        brass: "#C9A15F",
      },
      fontFamily: {
        display: ["Fraunces", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
