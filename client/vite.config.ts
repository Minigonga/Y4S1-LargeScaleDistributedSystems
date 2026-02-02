import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";   // ✅ Tailwind v4 plugin

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  // removed proxy so that client connects to the multiple cloud servers directly
});
