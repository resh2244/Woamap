import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import MapView, { type Building } from "./MapView";
import {
  supabase,
  supabaseConfigured,
  supabaseUrl,
  supabaseKey,
  configureSupabaseCredentials,
} from "./supabase";

const DEMO_BUILDINGS: Building[] = [
  {
    id: "demo-apartment",
    name: "WooMap Demo Apartment",
    address: "Victoria Island, Lagos, Nigeria",
    building_type: "Apartment",
    height_m: 52,
    status: "published",
    coordinates: [
      [3.421, 6.428],
      [3.4214, 6.428],
      [3.4214, 6.4284],
      [3.421, 6.4284],
      [3.421, 6.428],
    ],
  },
  {
    id: "demo-tech-hub",
    name: "Lagos Digital Center",
    address: "Adeola Odeku St, Victoria Island, Lagos",
    building_type: "Office",
    height_m: 84,
    status: "published",
    coordinates: [
      [3.4222, 6.4278],
      [3.4228, 6.4278],
      [3.4228, 6.4283],
      [3.4222, 6.4283],
      [3.4222, 6.4278],
    ],
  },
];

const CITY_PRESETS = [
  { name: "Lagos (VI)", lng: 3.4212, lat: 6.4282, zoom: 15 },
  { name: "Lagos Island", lng: 3.3958, lat: 6.4549, zoom: 15 },
  { name: "New York (Manhattan)", lng: -73.9855, lat: 40.7484, zoom: 15 },
  { name: "Tokyo (Shinjuku)", lng: 139.6917, lat: 35.6895, zoom: 15 },
  { name: "London (The City)", lng: -0.0902, lat: 51.5138, zoom: 15 },
  { name: "Paris (La Défense)", lng: 2.2402, lat: 48.8924, zoom: 15 },
];

type DraftForm = {
  name: string;
  address: string;
  building_type: string;
  height_m: number;
};

const emptyForm: DraftForm = {
  name: "New building",
  address: "",
  building_type: "Apartment",
  height_m: 10,
};

type RevisionRecord = {
  id: string | number;
  revision: number;
  action: string;
  editor_email: string | null;
  created_at: string;
  snapshot: any;
};

export default function App() {
  const [buildings, setBuildings] = useState<Building[]>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("woomap_local_buildings");
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {
          console.error(e);
        }
      }
    }
    return DEMO_BUILDINGS;
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [footprint, setFootprint] = useState<number[][] | null>(null);
  const [form, setForm] = useState<DraftForm>(emptyForm);
  const [addressQuery, setAddressQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [message, setMessage] = useState(
    supabaseConfigured
      ? "Supabase connected. Live synchronization active."
      : "Demo mode: connect Supabase to enable cloud database & multi-device sync."
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revisions, setRevisions] = useState<RevisionRecord[]>([]);
  const [showRevisions, setShowRevisions] = useState(false);
  const [filterLayer, setFilterLayer] = useState<"all" | "published" | "draft">("all");
  const [targetLocation, setTargetLocation] = useState<{ lng: number; lat: number; zoom?: number } | null>(null);

  // Modals
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSchemaModal, setShowSchemaModal] = useState(false);
  const [customUrl, setCustomUrl] = useState(supabaseUrl);
  const [customKey, setCustomKey] = useState(supabaseKey);
  const [copiedSchema, setCopiedSchema] = useState(false);

  const selected = useMemo(
    () => buildings.find((b) => b.id === selectedId) ?? null,
    [buildings, selectedId]
  );

  const filteredBuildings = useMemo(() => {
    if (filterLayer === "published") {
      return buildings.filter((b) => b.status === "published");
    }
    if (filterLayer === "draft") {
      return buildings.filter((b) => b.status === "draft");
    }
    return buildings;
  }, [buildings, filterLayer]);

  // Load cloud buildings from Supabase if configured
  const loadBuildings = useCallback(async () => {
    if (!supabase) {
      if (typeof window !== "undefined") {
        const saved = localStorage.getItem("woomap_local_buildings");
        if (saved) {
          try {
            setBuildings(JSON.parse(saved));
          } catch (e) {
            console.error(e);
          }
        }
      }
      return;
    }

    try {
      const { data, error } = await supabase
        .from("buildings")
        .select("id,name,address,building_type,height_m,status,footprint_geojson");

      if (error) {
        setMessage(`Could not load buildings: ${error.message}`);
        return;
      }

      const cloudBuildings: Building[] = (data ?? []).map((row: any) => {
        const geometry = row.footprint_geojson;
        return {
          id: row.id,
          name: row.name,
          address: row.address,
          building_type: row.building_type,
          height_m: Number(row.height_m),
          status: row.status,
          coordinates: geometry.coordinates[0],
        };
      });

      setBuildings((current) => {
        const drafts = current.filter(
          (b) => b.id.startsWith("local-") && b.status === "draft"
        );
        return [...cloudBuildings, ...drafts];
      });
      setMessage(`Map loaded with ${cloudBuildings.length} cloud building(s).`);
    } catch (err) {
      console.error(err);
    }
  }, []);

  // Supabase Auth and Realtime subscription
  useEffect(() => {
    if (!supabase) return;
    let alive = true;

    async function initialize() {
      const { data } = await supabase!.auth.getSession();
      if (alive) setUserEmail(data.session?.user.email ?? null);
      await loadBuildings();
    }
    void initialize();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUserEmail(session?.user.email ?? null);
        if (session) void loadBuildings();
      }
    );

    const channel = supabase
      .channel("woomap-live-buildings")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "buildings",
        },
        () => {
          void loadBuildings();
        }
      )
      .subscribe();

    return () => {
      alive = false;
      authListener.subscription.unsubscribe();
      void supabase!.removeChannel(channel);
    };
  }, [loadBuildings]);

  // Persist local buildings to localStorage if in demo mode
  useEffect(() => {
    if (!supabaseConfigured && typeof window !== "undefined") {
      localStorage.setItem("woomap_local_buildings", JSON.stringify(buildings));
    }
  }, [buildings]);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      const building = buildings.find((b) => b.id === id);
      if (building) {
        setForm({
          name: building.name,
          address: building.address,
          building_type: building.building_type,
          height_m: building.height_m,
        });
        setFootprint(null);
        setShowRevisions(false);
        setMessage(`Selected: ${building.name} (${building.height_m}m)`);
      }
    },
    [buildings]
  );

  const handleDraw = useCallback((coordinates: number[][]) => {
    setFootprint(coordinates);
    setSelectedId(null);
    setDrawing(false);
    setMessage(
      `Footprint captured (${coordinates.length - 1} vertices). Fill details and click Publish or Save draft.`
    );
  }, []);

  async function searchAddress(event: FormEvent) {
    event.preventDefault();
    if (!addressQuery.trim()) return;
    setBusy(true);
    setResults([]);
    try {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("q", addressQuery);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "5");

      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) throw new Error("Address search service is busy or unavailable.");
      const data = await response.json();
      setResults(data);
      if (!data.length) setMessage("No matching addresses found.");
      else setMessage(`Found ${data.length} location(s). Select one to reposition map.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  function handleSelectAddress(result: any) {
    const lat = Number(result.lat);
    const lon = Number(result.lon);
    setAddressQuery(result.display_name);
    setResults([]);
    setForm((f) => ({
      ...f,
      address: result.display_name,
    }));

    // Reposition map with animation!
    setTargetLocation({ lng: lon, lat, zoom: 17 });
    setMessage(`Moved map to: ${result.display_name.slice(0, 40)}... Draw a footprint here!`);
  }

  // Quick generator for a standard building footprint at current address or center
  function handleGenerateFootprintAtCenter() {
    const centerLng = targetLocation?.lng ?? 3.4215;
    const centerLat = targetLocation?.lat ?? 6.4281;
    const delta = 0.0003; // ~30m footprint box

    const boxFootprint = [
      [centerLng - delta, centerLat - delta],
      [centerLng + delta, centerLat - delta],
      [centerLng + delta, centerLat + delta],
      [centerLng - delta, centerLat + delta],
      [centerLng - delta, centerLat - delta],
    ];

    setFootprint(boxFootprint);
    setSelectedId(null);
    setDrawing(false);
    setMessage("Generated 30m x 30m standard footprint. Adjust details and save!");
  }

  async function saveBuilding(publish: boolean) {
    if (!footprint && !selected) {
      setMessage("Draw a footprint on the map or select an existing building first.");
      return;
    }
    if (!form.name.trim() || !form.address.trim()) {
      setMessage("Enter a building name and address.");
      return;
    }
    if (
      !Number.isFinite(form.height_m) ||
      form.height_m <= 0 ||
      form.height_m > 1000
    ) {
      setMessage("Height must be greater than 0 and at most 1000 metres.");
      return;
    }

    const coordinates = footprint ?? selected?.coordinates;
    if (!coordinates || coordinates.length < 4) {
      setMessage("The building footprint must have at least 3 vertices and be closed.");
      return;
    }

    const statusVal = publish ? "published" : "draft";

    // 1. Supabase Mode
    if (supabase && userEmail) {
      const { data: sessionData } = await supabase.auth.getSession();
      const user = sessionData.session?.user;
      if (!user) {
        setMessage("Your session has expired. Please sign in again.");
        return;
      }

      const record = {
        owner_id: user.id,
        name: form.name.trim(),
        address: form.address.trim(),
        building_type: form.building_type,
        height_m: form.height_m,
        footprint_geojson: {
          type: "Polygon",
          coordinates: [coordinates],
        },
        status: statusVal,
      };

      setBusy(true);
      try {
        let result;
        if (selected && !selected.id.startsWith("local-") && !selected.id.startsWith("demo-")) {
          result = await supabase
            .from("buildings")
            .update(record)
            .eq("id", selected.id)
            .select("id")
            .single();
        } else {
          result = await supabase
            .from("buildings")
            .insert(record)
            .select("id")
            .single();
        }

        if (result.error) throw result.error;
        setMessage(
          publish
            ? "✓ Building successfully published to the cloud WooMap!"
            : "✓ Building draft saved to Supabase."
        );
        setFootprint(null);
        setSelectedId(null);
        await loadBuildings();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Could not save building."
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    // 2. Demo Local Mode fallback
    const id = selected ? selected.id : `local-${Date.now()}`;
    const newBuilding: Building = {
      id,
      name: form.name.trim(),
      address: form.address.trim(),
      building_type: form.building_type,
      height_m: form.height_m,
      status: statusVal,
      coordinates,
    };

    setBuildings((prev) => {
      const exists = prev.some((b) => b.id === id);
      if (exists) {
        return prev.map((b) => (b.id === id ? newBuilding : b));
      }
      return [...prev, newBuilding];
    });

    // Save demo revision
    const existingRevsStr = localStorage.getItem(`woomap_revs_${id}`);
    const existingRevs: RevisionRecord[] = existingRevsStr ? JSON.parse(existingRevsStr) : [];
    const nextRevNum = existingRevs.length + 1;
    const newRev: RevisionRecord = {
      id: `rev-${Date.now()}`,
      revision: nextRevNum,
      action: selected ? (publish ? "published" : "updated") : "created",
      editor_email: userEmail ?? "demo_user@woomap.app",
      created_at: new Date().toISOString(),
      snapshot: newBuilding,
    };
    localStorage.setItem(`woomap_revs_${id}`, JSON.stringify([newRev, ...existingRevs]));

    setMessage(
      publish
        ? `✓ Building "${newBuilding.name}" published locally (${newBuilding.height_m}m). Connect Supabase to share live!`
        : `✓ Building draft saved locally.`
    );
    setFootprint(null);
    setSelectedId(null);
  }

  async function handleDeleteBuilding() {
    if (!selected) return;
    if (!window.confirm(`Are you sure you want to delete "${selected.name}"?`)) return;

    if (supabase && userEmail && !selected.id.startsWith("local-") && !selected.id.startsWith("demo-")) {
      setBusy(true);
      try {
        const { error } = await supabase.from("buildings").delete().eq("id", selected.id);
        if (error) throw error;
        setMessage("Building deleted from cloud.");
        setSelectedId(null);
        await loadBuildings();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : "Failed to delete building.");
      } finally {
        setBusy(false);
      }
      return;
    }

    // Local deletion
    setBuildings((prev) => prev.filter((b) => b.id !== selected.id));
    setSelectedId(null);
    setMessage(`Building "${selected.name}" deleted.`);
  }

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (!supabase) {
      setMessage("Add your Supabase credentials first in Settings.");
      setShowSettingsModal(true);
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      setMessage("Signed in successfully to Supabase.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    if (!supabase) {
      setMessage("Configure your Supabase URL & Key first.");
      setShowSettingsModal(true);
      return;
    }
    if (!email || password.length < 8) {
      setMessage("Enter an email and a password of at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      setMessage("Account created. Check email if confirmation is required.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Registration failed.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    setMessage(error ? error.message : "Signed out.");
    setUserEmail(null);
  }

  async function loadRevisions() {
    if (!selected) return;

    if (supabase && !selected.id.startsWith("local-") && !selected.id.startsWith("demo-")) {
      const { data, error } = await supabase
        .from("building_revisions")
        .select("id,revision,action,editor_email,created_at,snapshot")
        .eq("building_id", selected.id)
        .order("revision", { ascending: false });
      if (error) {
        setMessage(`Could not load revisions: ${error.message}`);
        return;
      }
      setRevisions(data ?? []);
      setShowRevisions(true);
      return;
    }

    // Local revisions
    const saved = localStorage.getItem(`woomap_revs_${selected.id}`);
    if (saved) {
      try {
        setRevisions(JSON.parse(saved));
      } catch {
        setRevisions([]);
      }
    } else {
      setRevisions([
        {
          id: 1,
          revision: 1,
          action: "created",
          editor_email: "demo@woomap.app",
          created_at: new Date().toISOString(),
          snapshot: selected,
        },
      ]);
    }
    setShowRevisions(true);
  }

  function handleRestoreRevision(rev: RevisionRecord) {
    if (!rev.snapshot) return;
    const snap = rev.snapshot;
    setForm({
      name: snap.name ?? form.name,
      address: snap.address ?? form.address,
      building_type: snap.building_type ?? form.building_type,
      height_m: Number(snap.height_m ?? form.height_m),
    });
    if (snap.footprint_geojson?.coordinates?.[0]) {
      setFootprint(snap.footprint_geojson.coordinates[0]);
    } else if (snap.coordinates) {
      setFootprint(snap.coordinates);
    }
    setMessage(`Restored form to revision ${rev.revision}. Click Publish or Save draft to commit.`);
  }

  const canEdit = Boolean(userEmail && supabaseConfigured) || !supabaseConfigured;

  return (
    <main className="app-shell">
      {/* Top Navbar */}
      <header className="topbar">
        <a className="brand" href="/">
          <div className="brand-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
              <line x1="8" y1="2" x2="8" y2="18" />
              <line x1="16" y1="6" x2="16" y2="22" />
            </svg>
          </div>
          <div>
            <span>WooMap</span>
            <small>Your world, updated live.</small>
          </div>
        </a>

        {/* Global Geocoder Search */}
        <form className="search" onSubmit={searchAddress}>
          <span className="text-slate-400 pl-1 text-sm">🔍</span>
          <input
            value={addressQuery}
            onChange={(e) => setAddressQuery(e.target.value)}
            placeholder="Search addresses, cities, or landmarks (e.g. Lagos, Times Square)..."
            aria-label="Search addresses"
          />
          <button type="submit" disabled={busy} className="search-btn text-xs">
            {busy ? "..." : "Search"}
          </button>
        </form>

        {/* Account / Configuration Header */}
        <div className="account">
          <button
            type="button"
            className="secondary text-xs flex items-center gap-1.5"
            onClick={() => setShowSchemaModal(true)}
            title="View database schema SQL"
          >
            <span>📜</span> SQL Schema
          </button>

          <button
            type="button"
            className="secondary text-xs flex items-center gap-1.5"
            onClick={() => setShowSettingsModal(true)}
            title="Database configuration"
          >
            <span>⚙️</span> Database
          </button>

          {userEmail ? (
            <div className="flex items-center gap-2">
              <span className="user-email" title={userEmail}>
                👤 {userEmail}
              </span>
              <button type="button" className="secondary text-xs" onClick={signOut}>
                Sign out
              </button>
            </div>
          ) : (
            <span
              className="mode-pill cursor-pointer hover:border-slate-400 transition"
              onClick={() => setShowSettingsModal(true)}
            >
              <span className={supabaseConfigured ? "online" : "offline"} />
              {supabaseConfigured ? "Supabase live" : "Demo local mode"}
            </span>
          )}
        </div>
      </header>

      {/* Main Workspace Layout */}
      <div className="workspace">
        {/* Left Sidebar */}
        <aside className="sidebar">
          <p className="section-label">WORKSPACE</p>
          <button
            className={`nav-item ${!drawing ? "active" : ""}`}
            onClick={() => {
              setDrawing(false);
              setFootprint(null);
            }}
          >
            <span>⌖</span> Live 3D Map
          </button>
          <button
            className={`nav-item ${drawing ? "active" : ""}`}
            onClick={() => {
              setSelectedId(null);
              setFootprint(null);
              setDrawing(true);
              setMessage("Click corners on the map to draw building footprint.");
            }}
          >
            <span>＋</span> Draw building footprint
          </button>
          <button
            className="nav-item"
            onClick={() => {
              setSelectedId(null);
              setFootprint(null);
              setForm(emptyForm);
              setMessage("Ready for new building. Draw footprint on map.");
            }}
          >
            <span>▧</span> Reset form
          </button>
          <button className="nav-item" onClick={() => void loadBuildings()}>
            <span>↻</span> Refresh map
          </button>

          <div className="sidebar-divider" />

          {/* Quick Fly-To City Presets */}
          <p className="section-label">WORLD EXPLORER</p>
          <div className="flex flex-col gap-1">
            {CITY_PRESETS.map((city) => (
              <button
                key={city.name}
                type="button"
                className="text-left text-xs py-1.5 px-2 rounded hover:bg-slate-800 text-slate-300 hover:text-white transition flex items-center justify-between"
                onClick={() => {
                  setTargetLocation({ lng: city.lng, lat: city.lat, zoom: city.zoom });
                  setMessage(`Navigating to ${city.name}...`);
                }}
              >
                <span>📍 {city.name}</span>
                <span className="text-[10px] text-slate-500">Go</span>
              </button>
            ))}
          </div>

          <div className="sidebar-divider" />

          {/* Map Layer Filter */}
          <p className="section-label">MAP LAYERS</p>
          <div
            className={`layer-row ${filterLayer === "all" ? "bg-slate-800/60 font-semibold" : ""}`}
            onClick={() => setFilterLayer("all")}
          >
            <span className="layer-dot blue" />
            All buildings
            <span className="layer-count">{buildings.length}</span>
          </div>
          <div
            className={`layer-row ${filterLayer === "published" ? "bg-slate-800/60 font-semibold" : ""}`}
            onClick={() => setFilterLayer("published")}
          >
            <span className="layer-dot green" />
            Published
            <span className="layer-count">
              {buildings.filter((b) => b.status === "published").length}
            </span>
          </div>
          <div
            className={`layer-row ${filterLayer === "draft" ? "bg-slate-800/60 font-semibold" : ""}`}
            onClick={() => setFilterLayer("draft")}
          >
            <span className="layer-dot amber" />
            Drafts
            <span className="layer-count">
              {buildings.filter((b) => b.status === "draft").length}
            </span>
          </div>

          <div className="sidebar-bottom">
            <p className="section-label">CONNECTION STATUS</p>
            <p className="connection">
              <span className={supabaseConfigured ? "online" : "offline"} />
              {supabaseConfigured ? "Supabase Online" : "Demo Mode"}
            </p>
            <p className="muted small mt-1">
              {supabaseConfigured
                ? "Live Postgres synchronization enabled. Building updates sync across browsers."
                : "Local sandbox mode. Connect Supabase to persist in PostGIS and share."}
            </p>
          </div>
        </aside>

        {/* Center Map Area */}
        <section className="map-area">
          <div className="map-toolbar">
            <div>
              <span className="live-dot" />
              <strong>Shared 3D Map</strong>
              <span className="muted">
                · {filteredBuildings.length} visible building(s)
              </span>
            </div>
            <div className="flex items-center gap-2">
              {selected && (
                <button
                  type="button"
                  className="secondary text-xs"
                  onClick={() => {
                    if (selected.coordinates[0]) {
                      setTargetLocation({
                        lng: selected.coordinates[0][0],
                        lat: selected.coordinates[0][1],
                        zoom: 17,
                      });
                    }
                  }}
                >
                  Focus selected
                </button>
              )}
              <button
                className={drawing ? "primary text-xs" : "secondary text-xs"}
                onClick={() => {
                  setFootprint(null);
                  setDrawing(!drawing);
                }}
              >
                {drawing ? "Cancel drawing" : "＋ Draw footprint"}
              </button>
            </div>
          </div>

          {drawing && (
            <div className="drawing-banner">
              <span>
                ✏️ <strong>Drawing mode:</strong> Click at least 3 points on the map. Click near the start to close the polygon.
              </span>
              <button
                type="button"
                onClick={() => setDrawing(false)}
                className="text-xs text-amber-200 underline hover:text-white"
              >
                Exit
              </button>
            </div>
          )}

          {/* Interactive MapLibre 3D Extrusion Canvas */}
          <MapView
            buildings={filteredBuildings}
            selectedId={selectedId}
            drawing={drawing}
            targetLocation={targetLocation}
            onSelect={handleSelect}
            onDraw={handleDraw}
            onCancelDraw={() => setDrawing(false)}
          />

          <div className="map-attribution">
            © OpenStreetMap contributors · OpenFreeMap Liberty · MapLibre GL
          </div>
        </section>

        {/* Right Editor Panel */}
        <aside className="editor">
          <div className="editor-heading">
            <div>
              <p className="section-label">PROPERTY DETAILS</p>
              <h2>{selected ? "Edit building" : "New building"}</h2>
            </div>
            <span className="editor-icon">▧</span>
          </div>

          {/* Search Dropdown Results */}
          {results.length > 0 && (
            <div className="search-results">
              <strong>Select search location:</strong>
              {results.map((result) => (
                <button
                  key={result.place_id}
                  className="result-item"
                  onClick={() => handleSelectAddress(result)}
                >
                  <span>{result.display_name}</span>
                  <small>
                    Lat: {Number(result.lat).toFixed(4)}, Lon: {Number(result.lon).toFixed(4)}
                  </small>
                </button>
              ))}
            </div>
          )}

          {/* Auth box when Supabase is configured but user is not signed in */}
          {supabaseConfigured && !userEmail && (
            <form className="auth-box" onSubmit={authenticate}>
              <strong>Sign in to publish</strong>
              <p className="muted small">
                Sign in to save and sync buildings to your Supabase PostgreSQL cloud.
              </p>
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  minLength={8}
                  required
                />
              </label>
              <button className="primary full text-xs" disabled={busy}>
                Sign in
              </button>
              <button
                type="button"
                className="secondary full text-xs"
                disabled={busy}
                onClick={() => void register()}
              >
                Create account
              </button>
            </form>
          )}

          {/* Property Form */}
          <div className="editor-form">
            <label>
              Building name
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Victoria Tower, Lagos"
              />
            </label>

            <label>
              Address
              <div className="flex gap-2">
                <input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="Enter real-world address"
                />
              </div>
            </label>

            <label>
              Building type
              <select
                value={form.building_type}
                onChange={(e) =>
                  setForm({ ...form, building_type: e.target.value })
                }
              >
                <option>Apartment</option>
                <option>House</option>
                <option>Office</option>
                <option>Commercial building</option>
                <option>Skyscraper</option>
                <option>Hotel</option>
                <option>Landmark</option>
              </select>
            </label>

            <label>
              Height <span className="muted">(metres)</span>
              <div className="height-input">
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={form.height_m}
                  onChange={(e) =>
                    setForm({ ...form, height_m: Number(e.target.value) })
                  }
                />
                <span>m</span>
              </div>
            </label>

            {/* Quick Height Presets */}
            <div className="height-presets">
              {[5, 10, 20, 52, 100, 250].map((height) => (
                <button
                  key={height}
                  type="button"
                  className={form.height_m === height ? "preset active" : "preset"}
                  onClick={() => setForm({ ...form, height_m: height })}
                >
                  {height} m
                </button>
              ))}
            </div>

            {/* Visual 3D Height Scale Preview Box */}
            <div className="preview-box">
              <div className="preview-building">
                <div
                  className="preview-tower"
                  style={{
                    height: `${Math.max(14, Math.min(85, (form.height_m / 120) * 85))}px`,
                  }}
                />
              </div>
              <div className="flex flex-col">
                <strong>{form.height_m} metres</strong>
                <span className="text-xs text-sky-400 font-medium">
                  {form.building_type}
                </span>
                <p className="muted small mt-1">
                  Est. {Math.max(1, Math.round(form.height_m / 3.2))} floors (3D Extrusion)
                </p>
              </div>
            </div>

            {/* Footprint Status & Helper */}
            <div className="p-3 bg-slate-900/60 border border-slate-800 rounded-lg text-xs flex flex-col gap-2">
              <span className="text-slate-300">
                {footprint
                  ? `✓ Footprint captured: ${footprint.length - 1} vertices`
                  : selected
                  ? `Selected building footprint (${selected.coordinates.length - 1} vertices)`
                  : "No footprint active yet."}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="secondary text-xs flex-1"
                  onClick={() => {
                    setDrawing(true);
                    setSelectedId(null);
                  }}
                >
                  ✏️ Draw on map
                </button>
                <button
                  type="button"
                  className="secondary text-xs flex-1"
                  onClick={handleGenerateFootprintAtCenter}
                  title="Generate a 30m standard square footprint"
                >
                  ⬚ Quick 30m box
                </button>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                className="secondary full text-xs"
                disabled={busy}
                onClick={() => void saveBuilding(false)}
              >
                Save as draft
              </button>
              <button
                type="button"
                className="primary full text-xs"
                disabled={busy || !canEdit}
                onClick={() => void saveBuilding(true)}
              >
                {busy ? "Saving..." : "Publish changes live"}
              </button>

              {selected && (
                <div className="flex gap-2 pt-2 border-t border-slate-800">
                  <button
                    type="button"
                    className="secondary flex-1 text-xs"
                    onClick={() => void loadRevisions()}
                  >
                    Revision history
                  </button>
                  <button
                    type="button"
                    className="secondary text-xs text-rose-400 hover:text-rose-300"
                    onClick={() => void handleDeleteBuilding()}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>

            {/* Revisions list */}
            {showRevisions && (
              <div className="revisions">
                <div className="flex items-center justify-between">
                  <strong>Revision history</strong>
                  <button
                    type="button"
                    onClick={() => setShowRevisions(false)}
                    className="text-xs text-slate-400 hover:text-white"
                  >
                    ✕
                  </button>
                </div>
                {revisions.length === 0 && (
                  <p className="muted small">No revisions recorded yet.</p>
                )}
                {revisions.map((rev) => (
                  <div className="revision-row" key={rev.id}>
                    <div className="flex justify-between items-center">
                      <strong>Revision #{rev.revision}</strong>
                      <span className="capitalize px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-sky-400">
                        {rev.action}
                      </span>
                    </div>
                    <span className="text-slate-300">
                      Editor: {rev.editor_email ?? "Anonymous"}
                    </span>
                    <small>{new Date(rev.created_at).toLocaleString()}</small>
                    <button
                      type="button"
                      className="mt-1 text-left text-[11px] text-blue-400 hover:underline"
                      onClick={() => handleRestoreRevision(rev)}
                    >
                      ↺ Restore this version
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Bottom Status bar */}
      <footer className="statusbar">
        <span className="flex items-center gap-2">
          <span className="online" />
          {message}
        </span>
        <span className="muted">
          WooMap Platform · MapLibre GL · OpenFreeMap Liberty · PostGIS Ready
        </span>
      </footer>

      {/* Supabase Settings Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-lg text-white">Supabase Configuration</h3>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Connect WooMap directly to your cloud Supabase database for live multi-user sync and PostGIS spatial storage.
            </p>
            <div className="flex flex-col gap-3">
              <label className="text-xs text-slate-200 font-semibold flex flex-col gap-1">
                Supabase Project URL
                <input
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://your-project.supabase.co"
                />
              </label>
              <label className="text-xs text-slate-200 font-semibold flex flex-col gap-1">
                Supabase Publishable / Anon Key
                <input
                  type="password"
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="secondary text-xs"
                onClick={() => {
                  configureSupabaseCredentials("", "");
                }}
              >
                Reset to Demo Mode
              </button>
              <button
                type="button"
                className="primary text-xs"
                onClick={() => {
                  configureSupabaseCredentials(customUrl, customKey);
                  setShowSettingsModal(false);
                }}
              >
                Save & Connect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Schema SQL Modal */}
      {showSchemaModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-2xl w-full max-h-[85vh] shadow-2xl flex flex-col gap-4">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="font-bold text-lg text-white">PostgreSQL & PostGIS Schema</h3>
                <p className="text-xs text-slate-400">Run this in your Supabase SQL Editor</p>
              </div>
              <button
                type="button"
                onClick={() => setShowSchemaModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 overflow-y-auto max-h-[50vh] text-[11px] font-mono text-emerald-300">
              <pre>{`-- WooMap PostGIS Schema for Supabase
create extension if not exists postgis with schema extensions;

create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 200),
  address text not null check (length(trim(address)) between 1 and 500),
  building_type text not null default 'Apartment',
  height_m double precision not null default 10 check (height_m > 0 and height_m <= 1000),
  footprint_geojson jsonb not null,
  footprint extensions.geometry(Polygon, 4326) not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index buildings_footprint_gix on public.buildings using gist (footprint);
create index buildings_status_idx on public.buildings (status);

alter table public.buildings enable row level security;
grant select on public.buildings to anon, authenticated;
grant insert, update, delete on public.buildings to authenticated;

create policy "Read published or owned buildings" on public.buildings
for select to anon, authenticated using (status = 'published' or owner_id = (select auth.uid()));

create policy "Create own buildings" on public.buildings
for insert to authenticated with check (owner_id = (select auth.uid()));

create policy "Update own buildings" on public.buildings
for update to authenticated using (owner_id = (select auth.uid()));

-- Geometry synchronization trigger
create or replace function public.sync_building_geometry()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.footprint := extensions.st_setsrid(
    extensions.st_geomfromgeojson(new.footprint_geojson::text), 4326
  );
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

create trigger buildings_geometry_trigger before insert or update on public.buildings
for each row execute function public.sync_building_geometry();

-- Enable Realtime
alter publication supabase_realtime add table public.buildings;`}</pre>
            </div>
            <div className="flex justify-between items-center pt-2">
              <span className="text-xs text-slate-400">Located at <code>supabase/schema.sql</code></span>
              <button
                type="button"
                className="primary text-xs"
                onClick={() => {
                  navigator.clipboard.writeText(`create extension if not exists postgis with schema extensions;
create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 200),
  address text not null check (length(trim(address)) between 1 and 500),
  building_type text not null default 'Apartment',
  height_m double precision not null default 10 check (height_m > 0 and height_m <= 1000),
  footprint_geojson jsonb not null,
  footprint extensions.geometry(Polygon, 4326) not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index buildings_footprint_gix on public.buildings using gist (footprint);
create index buildings_status_idx on public.buildings (status);
alter table public.buildings enable row level security;
grant select on public.buildings to anon, authenticated;
grant insert, update, delete on public.buildings to authenticated;
create policy "Read published or owned buildings" on public.buildings
for select to anon, authenticated using (status = 'published' or owner_id = (select auth.uid()));
create policy "Create own buildings" on public.buildings
for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Update own buildings" on public.buildings
for update to authenticated using (owner_id = (select auth.uid()));
create or replace function public.sync_building_geometry()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.footprint := extensions.st_setsrid(
    extensions.st_geomfromgeojson(new.footprint_geojson::text), 4326
  );
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;
create trigger buildings_geometry_trigger before insert or update on public.buildings
for each row execute function public.sync_building_geometry();
alter publication supabase_realtime add table public.buildings;`);
                  setCopiedSchema(true);
                  setTimeout(() => setCopiedSchema(false), 2000);
                }}
              >
                {copiedSchema ? "✓ Copied to clipboard!" : "Copy complete SQL"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
