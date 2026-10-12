import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { FeatureCollection, Polygon } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";

export type Building = {
  id: string;
  name: string;
  address: string;
  building_type: string;
  height_m: number;
  status: "draft" | "published";
  coordinates: number[][];
};

type Props = {
  buildings: Building[];
  selectedId: string | null;
  drawing: boolean;
  targetLocation?: { lng: number; lat: number; zoom?: number } | null;
  onSelect: (id: string) => void;
  onDraw: (coordinates: number[][]) => void;
  onCancelDraw?: () => void;
};

const SOURCE = "woomap-buildings";
const DRAWING_SOURCE = "woomap-drawing-preview";

function featureCollection(buildings: Building[]): FeatureCollection<Polygon> {
  return {
    type: "FeatureCollection",
    features: buildings.map((building) => ({
      type: "Feature",
      id: building.id,
      properties: {
        id: building.id,
        name: building.name,
        address: building.address,
        building_type: building.building_type,
        height: building.height_m,
        status: building.status,
      },
      geometry: {
        type: "Polygon",
        coordinates: [building.coordinates],
      },
    })),
  };
}

export default function MapView({
  buildings,
  selectedId,
  drawing,
  targetLocation,
  onSelect,
  onDraw,
  onCancelDraw,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const buildingsRef = useRef(buildings);
  const selectedRef = useRef(selectedId);
  const drawingRef = useRef(drawing);
  const [activePoints, setActivePoints] = useState<number[][]>([]);
  const pointsRef = useRef<number[][]>([]);
  const drawingMarkersRef = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    buildingsRef.current = buildings;
    const map = mapRef.current;
    if (!map || !map.getSource(SOURCE)) return;
    (map.getSource(SOURCE) as maplibregl.GeoJSONSource).setData(
      featureCollection(buildings)
    );
  }, [buildings]);

  // Color updates based on selected building
  useEffect(() => {
    selectedRef.current = selectedId;
    const map = mapRef.current;
    if (!map || !map.getLayer("woomap-3d")) return;

    map.setPaintProperty("woomap-3d", "fill-extrusion-color", [
      "case",
      ["==", ["get", "id"], selectedId ?? ""],
      "#f59e0b", // Gold for selected
      ["==", ["get", "status"], "draft"],
      "#94a3b8", // Slate for drafts
      "#3b82f6", // Vivid blue for published
    ]);
  }, [selectedId]);

  // Fly to target location if provided
  useEffect(() => {
    if (!targetLocation || !mapRef.current) return;
    mapRef.current.flyTo({
      center: [targetLocation.lng, targetLocation.lat],
      zoom: targetLocation.zoom ?? 16,
      pitch: 55,
      bearing: -20,
      essential: true,
      duration: 2000,
    });
  }, [targetLocation]);

  // Handle drawing state transitions
  useEffect(() => {
    drawingRef.current = drawing;
    const map = mapRef.current;

    if (!drawing) {
      pointsRef.current = [];
      setActivePoints([]);
      drawingMarkersRef.current.forEach((m) => m.remove());
      drawingMarkersRef.current = [];
      if (map && map.getSource(DRAWING_SOURCE)) {
        (map.getSource(DRAWING_SOURCE) as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: [],
        });
      }
    }

    if (!map) return;
    map.getCanvas().style.cursor = drawing ? "crosshair" : "";
  }, [drawing]);

  const updateDrawingPreview = (pts: number[][]) => {
    const map = mapRef.current;
    if (!map || !map.getSource(DRAWING_SOURCE)) return;

    const features: any[] = [];
    if (pts.length >= 2) {
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: pts,
        },
        properties: {},
      });
    }
    if (pts.length >= 3) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [[...pts, pts[0]]],
        },
        properties: {},
      });
    }

    (map.getSource(DRAWING_SOURCE) as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    });
  };

  const handleFinishDrawing = () => {
    const pts = pointsRef.current;
    if (pts.length < 3) return;
    const closed = [...pts, pts[0]];
    pointsRef.current = [];
    setActivePoints([]);
    drawingMarkersRef.current.forEach((m) => m.remove());
    drawingMarkersRef.current = [];
    updateDrawingPreview([]);
    onDraw(closed);
  };

  const handleUndoPoint = () => {
    if (pointsRef.current.length === 0) return;
    const updated = pointsRef.current.slice(0, -1);
    pointsRef.current = updated;
    setActivePoints(updated);

    const lastMarker = drawingMarkersRef.current.pop();
    lastMarker?.remove();

    updateDrawingPreview(updated);
  };

  // Initialize MapLibre
  useEffect(() => {
    if (!container.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: container.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [3.3792, 6.5244], // Default Lagos center
      zoom: 15,
      pitch: 50,
      bearing: -15,
      maxPitch: 85,
    });

    mapRef.current = map;

    // Controls
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    map.addControl(new maplibregl.FullscreenControl(), "top-right");

    map.on("load", () => {
      // 1. Buildings Source
      map.addSource(SOURCE, {
        type: "geojson",
        data: featureCollection(buildingsRef.current),
      });

      // 3D fill extrusion layer
      map.addLayer({
        id: "woomap-3d",
        type: "fill-extrusion",
        source: SOURCE,
        paint: {
          "fill-extrusion-color": [
            "case",
            ["==", ["get", "id"], selectedRef.current ?? ""],
            "#f59e0b",
            ["==", ["get", "status"], "draft"],
            "#94a3b8",
            "#3b82f6",
          ],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.88,
        },
      });

      // 2. Drawing preview source & layers
      map.addSource(DRAWING_SOURCE, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      // Drawing polygon preview
      map.addLayer({
        id: "woomap-draw-fill",
        type: "fill",
        source: DRAWING_SOURCE,
        filter: ["==", "$type", "Polygon"],
        paint: {
          "fill-color": "#f59e0b",
          "fill-opacity": 0.25,
        },
      });

      // Drawing line preview
      map.addLayer({
        id: "woomap-draw-line",
        type: "line",
        source: DRAWING_SOURCE,
        paint: {
          "line-color": "#f59e0b",
          "line-width": 3,
          "line-dasharray": [2, 1],
        },
      });

      // Interaction handlers for buildings
      map.on("click", "woomap-3d", (event) => {
        if (drawingRef.current) return;
        const id = event.features?.[0]?.properties?.id;
        if (id) onSelect(String(id));
      });

      map.on("mouseenter", "woomap-3d", () => {
        if (!drawingRef.current) {
          map.getCanvas().style.cursor = "pointer";
        }
      });

      map.on("mouseleave", "woomap-3d", () => {
        if (!drawingRef.current) {
          map.getCanvas().style.cursor = "";
        }
      });

      // Canvas drawing click handler
      map.on("click", (event) => {
        if (!drawingRef.current) return;

        const point = [
          Number(event.lngLat.lng.toFixed(7)),
          Number(event.lngLat.lat.toFixed(7)),
        ];

        // Check if user clicked near the starting point to complete
        if (pointsRef.current.length >= 3) {
          const first = pointsRef.current[0];
          const distance = Math.hypot(first[0] - point[0], first[1] - point[1]);
          if (distance < 0.00015) {
            const closed = [...pointsRef.current, first];
            pointsRef.current = [];
            setActivePoints([]);
            drawingMarkersRef.current.forEach((m) => m.remove());
            drawingMarkersRef.current = [];
            updateDrawingPreview([]);
            onDraw(closed);
            return;
          }
        }

        const nextPoints = [...pointsRef.current, point];
        pointsRef.current = nextPoints;
        setActivePoints(nextPoints);

        // Add marker for vertex
        const isFirst = nextPoints.length === 1;
        const markerEl = document.createElement("div");
        markerEl.className = "drawing-point-marker";
        markerEl.style.width = isFirst ? "14px" : "10px";
        markerEl.style.height = isFirst ? "14px" : "10px";
        markerEl.style.backgroundColor = isFirst ? "#10b981" : "#f59e0b";
        markerEl.style.border = "2px solid #ffffff";
        markerEl.style.borderRadius = "50%";
        markerEl.style.boxShadow = "0 0 6px rgba(0,0,0,0.5)";

        const marker = new maplibregl.Marker({ element: markerEl })
          .setLngLat(point as [number, number])
          .addTo(map);

        drawingMarkersRef.current.push(marker);
        updateDrawingPreview(nextPoints);
      });
    });

    return () => {
      drawingMarkersRef.current.forEach((m) => m.remove());
      map.remove();
      mapRef.current = null;
    };
  }, [onSelect, onDraw]);

  return (
    <div className="relative w-full h-full min-h-[500px]">
      <div ref={container} className="map-canvas w-full h-full" />

      {/* Floating Drawing Control Overlay */}
      {drawing && (
        <div className="absolute top-4 left-4 z-20 flex flex-col gap-2 p-3 bg-slate-900/95 backdrop-blur border border-amber-500/50 rounded-xl shadow-2xl text-xs text-slate-100 max-w-xs">
          <div className="flex items-center gap-2 font-semibold text-amber-400">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
            Drawing Footprint ({activePoints.length} vertices)
          </div>
          <p className="text-slate-300 leading-relaxed text-[11px]">
            {activePoints.length === 0
              ? "Click on the map to place the first corner of your building."
              : activePoints.length < 3
              ? `Placed ${activePoints.length} points. Click at least ${3 - activePoints.length} more corner(s).`
              : "Click near the green start point or click 'Finish Footprint' to close the building polygon."}
          </p>
          <div className="flex items-center gap-1.5 pt-1">
            {activePoints.length >= 3 && (
              <button
                type="button"
                onClick={handleFinishDrawing}
                className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg text-[11px] shadow transition"
              >
                Finish Footprint
              </button>
            )}
            {activePoints.length > 0 && (
              <button
                type="button"
                onClick={handleUndoPoint}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-[11px] transition"
              >
                Undo Point
              </button>
            )}
            <button
              type="button"
              onClick={onCancelDraw}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-rose-900/50 text-slate-300 hover:text-rose-200 rounded-lg text-[11px] transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
