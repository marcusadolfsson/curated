"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, MarkerClusterGroup } from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import type { TravelPost } from "@/app/api/travel/route";

/**
 * Every travel post as a dot on a world map.
 *
 * Nearby posts gather into a circle carrying their count; zooming in breaks
 * a circle into the regions and then the places inside it, and a single dot
 * opens its post. The clustering is Leaflet.markercluster's, so the counts are
 * whatever is close together at the current zoom - a continent from far out,
 * a valley up close - rather than a fixed country/region split.
 *
 * The map tiles are Esri's light and dark grey canvases, which need no key
 * (CARTO's, the first choice, started asking for one). They are loaded by the
 * browser looking at the page; nothing about the posts is sent anywhere to
 * draw it.
 */
export default function TravelMap({
  posts,
  onOpen,
  onSelect,
}: {
  posts: TravelPost[];
  onOpen: (post: TravelPost) => void;
  /** A circle was tapped: the posts inside it, to list under the map. */
  onSelect: (posts: TravelPost[]) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const cluster = useRef<MarkerClusterGroup | null>(null);
  // The latest handler, so markers made once still open the right thing.
  const open = useRef(onOpen);
  open.current = onOpen;
  const select = useRef(onSelect);
  select.current = onSelect;
  /** Which post each marker stands for, so a circle can say what is in it. */
  const postOf = useRef(new WeakMap<object, TravelPost>());

  // The map itself, once. Leaflet reaches for window, so it is loaded here
  // rather than at the top, where it would run during server rendering.
  useEffect(() => {
    let cancelled = false;
    let dark: MediaQueryList | null = null;
    let onScheme: (() => void) | null = null;

    void (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet.markercluster");
      if (cancelled || !element.current || map.current) return;

      const instance = L.map(element.current, {
        worldCopyJump: true,
        minZoom: 1,
        maxZoom: 16,
        zoomControl: true,
        attributionControl: true,
      }).setView([25, 10], 1);

      const tiles = (isDark: boolean) =>
        L.tileLayer(
          `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${isDark ? "World_Dark_Gray_Base" : "World_Light_Gray_Base"}/MapServer/tile/{z}/{y}/{x}`,
          {
            maxZoom: 16,
            attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
          },
        );

      dark = window.matchMedia("(prefers-color-scheme: dark)");
      let layer = tiles(dark.matches).addTo(instance);
      onScheme = () => {
        instance.removeLayer(layer);
        layer = tiles(Boolean(dark?.matches)).addTo(instance);
      };
      dark.addEventListener("change", onScheme);

      cluster.current = L.markerClusterGroup({
        showCoverageOnHover: false,
        // A tap on a circle lists what is in it, and zooms in as well - also
        // at the closest zoom, where posts at one spot used to fan out.
        zoomToBoundsOnClick: false,
        spiderfyOnMaxZoom: false,
        maxClusterRadius: 48,
        iconCreateFunction: (group) => {
          const count = group.getChildCount();
          const size = Math.round(Math.min(56, 26 + Math.log2(count) * 6));
          return L.divIcon({
            html: `<span>${count}</span>`,
            className: "travel-cluster",
            iconSize: [size, size],
          });
        },
      }).addTo(instance);

      cluster.current.on("clusterclick", (event) => {
        const group = (event as unknown as { layer: import("leaflet").MarkerCluster }).layer;
        const inside = group
          .getAllChildMarkers()
          .map((marker) => postOf.current.get(marker))
          .filter((post): post is TravelPost => Boolean(post));
        select.current(inside);
        if (instance.getZoom() < instance.getMaxZoom()) {
          instance.fitBounds(group.getBounds(), { padding: [32, 32], maxZoom: instance.getMaxZoom() });
        }
      });

      map.current = instance;
      draw(L);
    })();

    return () => {
      cancelled = true;
      if (dark && onScheme) dark.removeEventListener("change", onScheme);
      map.current?.remove();
      map.current = null;
      cluster.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The dots, whenever the posts change.
  useEffect(() => {
    void import("leaflet").then(({ default: L }) => draw(L));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts]);

  function draw(L: typeof import("leaflet")) {
    const group = cluster.current;
    const instance = map.current;
    if (!group || !instance) return;

    group.clearLayers();
    const placed = posts.filter((post) => post.lat !== null && post.lng !== null);
    for (const post of placed) {
      const marker = L.marker([post.lat as number, post.lng as number], {
        icon: L.divIcon({ className: "travel-dot", iconSize: [14, 14] }),
        title: post.place ?? post.city ?? post.region,
        keyboard: true,
      });
      marker.bindTooltip(escape(post.city ?? post.place ?? post.region), { direction: "top", offset: [0, -8] });
      marker.on("click", () => open.current(post));
      postOf.current.set(marker, post);
      group.addLayer(marker);
    }

    if (placed.length > 0 && !fitted.current) {
      fitted.current = true;
      instance.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 4 });
    }
  }

  /** Fit to the dots once, on the first draw, and leave the view alone after. */
  const fitted = useRef(false);

  return (
    <div
      ref={element}
      className="travel-map h-[280px] w-full overflow-hidden rounded-xl ring-1 ring-line sm:h-[380px] [&_.travel-cluster]:cursor-pointer"
      aria-label="Map of travel posts"
    />
  );
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
