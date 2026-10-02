"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, MarkerClusterGroup } from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import type { TravelPost } from "@/app/api/travel/route";

/**
 * Every travel post as a dot on a world map.
 *
 * Nearby posts gather into a circle carrying their count; tapping or zooming
 * breaks a circle into the regions and then the places inside it, and a
 * single dot opens its post. Whatever the map shows is reported back, so the
 * list under it can follow the view as it pans and zooms. The clustering is Leaflet.markercluster's, so the counts are
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
  onViewChange,
}: {
  posts: TravelPost[];
  onOpen: (post: TravelPost) => void;
  /** The posts inside the area the map shows, whenever that changes. */
  onViewChange: (posts: TravelPost[]) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const cluster = useRef<MarkerClusterGroup | null>(null);
  // The latest handler, so markers made once still open the right thing.
  const open = useRef(onOpen);
  open.current = onOpen;
  const report = useRef(onViewChange);
  report.current = onViewChange;
  const latest = useRef(posts);
  latest.current = posts;

  /** Tell the page which posts are inside the area on screen. */
  function reportView() {
    const instance = map.current;
    if (!instance) return;
    const bounds = instance.getBounds();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();
    // Zoomed out far enough, the map shows more than one world across.
    const everyLongitude = east - west >= 360;
    report.current(
      latest.current.filter((post) => {
        if (post.lat === null || post.lng === null) return false;
        if (post.lat < south || post.lat > north) return false;
        if (everyLongitude) return true;
        // The view can sit across the date line, or on a copy of the world.
        const lng = ((((post.lng - west) % 360) + 360) % 360) + west;
        return lng <= east;
      }),
    );
  }

  // The map itself, once. Leaflet reaches for window, so it is loaded here
  // rather than at the top, where it would run during server rendering.
  useEffect(() => {
    let cancelled = false;
    let resize: ResizeObserver | null = null;
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
        // A tap on a circle zooms into it, and the list follows the view; at
        // the closest zoom, posts at one spot fan out to be tapped one by one.
        spiderfyOnMaxZoom: true,
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

      instance.on("moveend", reportView);

      // The map can be made before its box has a size - the page lays out
      // around it after the data arrives - and Leaflet measures once. Tell it
      // whenever the box changes, and fit the world to the dots once it can.
      resize = new ResizeObserver(() => {
        instance.invalidateSize();
        if (!fitted.current) draw(L);
      });
      resize.observe(element.current);

      map.current = instance;
      draw(L);
    })();

    return () => {
      cancelled = true;
      resize?.disconnect();
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
      group.addLayer(marker);
    }

    // Fitted only once the box has a size: fitting a zero-size map picks the
    // closest zoom allowed and puts the world's dots somewhere in Africa.
    if (placed.length > 0 && !fitted.current && instance.getSize().x > 0) {
      fitted.current = true;
      instance.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 4 });
    }
    reportView();
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
