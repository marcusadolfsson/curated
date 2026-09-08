import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Curated",
    short_name: "Curated",
    description: "Posts shared into your Instagram DMs, read and sorted.",
    start_url: "/",
    display: "standalone",
    background_color: "#eaebe4",
    theme_color: "#eaebe4",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
