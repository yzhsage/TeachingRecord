import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Must match the GitHub repo name so assets resolve correctly on
  // GitHub Pages (https://<user>.github.io/TeachingRecord/).
  base: "/TeachingRecord/",
});
