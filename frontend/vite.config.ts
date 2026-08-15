import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => ({
  base: mode === "ghpages" ? "/IDFinder/" : "/",
  plugins: [react()],
  envDir: ".",        //
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
