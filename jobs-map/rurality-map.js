/**
 * Script for rurality.html, the internal map of public/rurality-points.json (the plugin's rurality
 * lookup). Not part of the WordPress embed.
 *
 * A plain (non-module) script in public/, so Vite copies it to dist/ as is and emits nothing into
 * dist/assets (scripts/check-dist.mjs). It expects these globals, loaded from CDNs by rurality.html:
 * mapboxgl, d3 (d3-delaunay), topojson (topojson-client) and polygonClipping.
 *
 * The matching shown here mirrors scripts/lib/rurality.mjs: a job takes the label of the nearest
 * lookup point in its own state, measured with milesBetween(), if that point is within 15 miles.
 */
;(async () => {
  mapboxgl.accessToken =
    "pk.eyJ1IjoiY2hyaXN0b3BoZXJjb3NuZXIiLCJhIjoiY21kZGFoaXdsMDJ1ajJubjMxdjRzZTBsMyJ9.d4fDFXYKjga4Hhc_60jaqw"

  // Same constants and distance as scripts/lib/rurality.mjs.
  const MAX_MILES = 15
  const MILES_PER_DEGREE = 69.0
  const RADIUS_DEG = MAX_MILES / MILES_PER_DEGREE
  const toRad = (d) => (d * Math.PI) / 180
  function milesBetween(lng1, lat1, lng2, lat2) {
    const x = (lng2 - lng1) * Math.cos(toRad((lat1 + lat2) / 2))
    const y = lat2 - lat1
    return Math.sqrt(x * x + y * y) * MILES_PER_DEGREE
  }
  const STATE_CODES = Object.fromEntries(
    "Alabama:AL,Alaska:AK,Arizona:AZ,Arkansas:AR,California:CA,Colorado:CO,Connecticut:CT,Delaware:DE,Florida:FL,Georgia:GA,Hawaii:HI,Idaho:ID,Illinois:IL,Indiana:IN,Iowa:IA,Kansas:KS,Kentucky:KY,Louisiana:LA,Maine:ME,Maryland:MD,Massachusetts:MA,Michigan:MI,Minnesota:MN,Mississippi:MS,Missouri:MO,Montana:MT,Nebraska:NE,Nevada:NV,New Hampshire:NH,New Jersey:NJ,New Mexico:NM,New York:NY,North Carolina:NC,North Dakota:ND,Ohio:OH,Oklahoma:OK,Oregon:OR,Pennsylvania:PA,Rhode Island:RI,South Carolina:SC,South Dakota:SD,Tennessee:TN,Texas:TX,Utah:UT,Vermont:VT,Virginia:VA,Washington:WA,West Virginia:WV,Wisconsin:WI,Wyoming:WY,District of Columbia:DC,Puerto Rico:PR,Guam:GU,Virgin Islands:VI,American Samoa:AS,Northern Mariana Islands:MP"
      .split(",")
      .map((pair) => pair.split(":")),
  )

  const CLASSES = {
    U: { label: "Urban (RUCA 1, 1.1)", color: "#2563eb" },
    R: { label: "Rural (RUCA 2–9)", color: "#16a34a" },
    H: { label: "Highly rural (RUCA 10)", color: "#ea580c" },
    I: { label: "Insular (GU, VI, AS, MP)", color: "#9333ea" },
    X: { label: "Unknown (no tract / RUCA 99)", color: "#6b7280" },
  }

  const [lookup, jobs, statesTopo] = await Promise.all([
    fetch("./rurality-points.json").then((r) => r.json()),
    // One feature per distinct job location; built by `npm run build-rurality-sites`.
    fetch("./rurality-job-sites.geojson").then((r) => r.json()),
    // Census cartographic state outlines (1:10m), used to trim catchments at state lines.
    fetch("https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json").then((r) => r.json()),
  ])

  // State outlines as MultiPolygon coordinates, keyed by postal code. us-atlas spells two
  // territories differently from STATE_CODES.
  const ATLAS_NAMES = {
    "United States Virgin Islands": "Virgin Islands",
    "Commonwealth of the Northern Mariana Islands": "Northern Mariana Islands",
  }
  const stateShapes = {}
  for (const f of topojson.feature(statesTopo, statesTopo.objects.states).features) {
    const code = STATE_CODES[ATLAS_NAMES[f.properties.name] || f.properties.name]
    if (!code) continue
    const g = f.geometry
    stateShapes[code] = g.type === "Polygon" ? [g.coordinates] : g.coordinates
  }

  const insular = new Set(lookup.rules.insularStates)
  const counts = {}
  const features = []
  for (const [state, points] of Object.entries(lookup.states)) {
    for (const [lng, lat, raw] of points) {
      const c = insular.has(state) ? "I" : raw
      counts[c] = (counts[c] || 0) + 1
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { c, state },
      })
    }
  }

  /**
   * Catchment areas: within each state, the region whose nearest lookup point is a given point
   * (its Voronoi cell), clipped to that point's 15-mile circle. A job inside a blob takes the
   * blob's label; a job outside every blob in its state is "unknown". Built in a local
   * equirectangular projection (x = lng · cos(state mean lat)), matching milesBetween().
   *
   * Each state's blobs are then trimmed to that state's outline, since a job only ever matches
   * points in its own state. Blobs that touch no border or coastline (found with a grid of the
   * outline's segments) are kept as they are; the rest are intersected with the outline, cropped
   * to the blob's bounding box first so each intersection stays small.
   */
  function buildCatchments() {
    stats.trimmed = 0
    stats.dropped = 0
    const circle = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * 2 * Math.PI
      return [Math.cos(a) * RADIUS_DEG, Math.sin(a) * RADIUS_DEG] // counter-clockwise
    })
    const out = []
    for (const [state, points] of Object.entries(lookup.states)) {
      if (points.length === 0) continue
      const k = Math.cos(toRad(points.reduce((sum, p) => sum + p[1], 0) / points.length))
      const xy = points.map(([lng, lat]) => [lng * k, lat])
      const xs = xy.map((p) => p[0])
      const ys = xy.map((p) => p[1])
      const pad = RADIUS_DEG * 2
      const voronoi = d3.Delaunay.from(xy).voronoi([
        Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad,
      ])
      const shape = stateShapes[state]
      const borderGrid = shape && segmentGrid(shape)
      points.forEach(([lng, lat, raw], i) => {
        const cell = voronoi.cellPolygon(i)
        if (!cell) return // duplicate coordinate: its twin's cell covers it
        const [cx, cy] = xy[i]
        const clip = circle.map(([dx, dy]) => [cx + dx, cy + dy])
        const ring = clipConvex(cell.slice(0, -1), clip)
        if (ring.length < 3) return
        const coords = ring.map(([x, y]) => [x / k, y])
        coords.push(coords[0])
        const properties = { c: insular.has(state) ? "I" : raw, state }

        let geometry = { type: "Polygon", coordinates: [coords] }
        if (shape) {
          const [x0, y0, x1, y1] = ringBox(coords)
          if (!gridHit(borderGrid, x0, y0, x1, y1)) {
            // Entirely inside or entirely outside the state; the point decides which.
            if (!pointInShape(shape, lng, lat)) return void stats.dropped++
          } else {
            const local = cropToBox(shape, x0 - 1e-6, y0 - 1e-6, x1 + 1e-6, y1 + 1e-6)
            const trimmed = local.length ? polygonClipping.intersection([coords], local) : []
            stats.trimmed++
            if (!trimmed.length) return void stats.dropped++
            geometry = { type: "MultiPolygon", coordinates: trimmed }
          }
        }
        out.push({ type: "Feature", geometry, properties })
      })
    }
    return out
  }

  /** Sutherland–Hodgman: clip polygon `subject` by convex counter-clockwise polygon `clip`. */
  function clipConvex(subject, clip) {
    let output = subject
    for (let i = 0; i < clip.length && output.length; i++) {
      const a = clip[i]
      const b = clip[(i + 1) % clip.length]
      const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0
      const cross = (p, q) => {
        const dx1 = q[0] - p[0], dy1 = q[1] - p[1], dx2 = b[0] - a[0], dy2 = b[1] - a[1]
        const t = ((a[0] - p[0]) * dy2 - (a[1] - p[1]) * dx2) / (dx1 * dy2 - dy1 * dx2)
        return [p[0] + t * dx1, p[1] + t * dy1]
      }
      const input = output
      output = []
      for (let j = 0; j < input.length; j++) {
        const p = input[j]
        const q = input[(j + 1) % input.length]
        if (inside(q)) {
          if (!inside(p)) output.push(cross(p, q))
          output.push(q)
        } else if (inside(p)) {
          output.push(cross(p, q))
        }
      }
    }
    return output
  }

  // --- State outline helpers (all in plain lng/lat) ---

  const GRID = 0.1 // degrees per grid square for the border-segment index

  /** Set of grid squares that any outline segment passes through (by segment bounding box). */
  function segmentGrid(shape) {
    const grid = new Set()
    for (const polygon of shape) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [x1, y1] = ring[i]
          const [x2, y2] = ring[i + 1]
          for (let gx = Math.floor(Math.min(x1, x2) / GRID); gx <= Math.floor(Math.max(x1, x2) / GRID); gx++) {
            for (let gy = Math.floor(Math.min(y1, y2) / GRID); gy <= Math.floor(Math.max(y1, y2) / GRID); gy++) {
              grid.add(`${gx},${gy}`)
            }
          }
        }
      }
    }
    return grid
  }

  function gridHit(grid, x0, y0, x1, y1) {
    for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++) {
      for (let gy = Math.floor(y0 / GRID); gy <= Math.floor(y1 / GRID); gy++) {
        if (grid.has(`${gx},${gy}`)) return true
      }
    }
    return false
  }

  const ringBoxes = new WeakMap()
  function ringBox(ring) {
    let box = ringBoxes.get(ring)
    if (!box) {
      box = [Infinity, Infinity, -Infinity, -Infinity]
      for (const [x, y] of ring) {
        box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y)
        box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y)
      }
      ringBoxes.set(ring, box)
    }
    return box
  }

  /** Even-odd point-in-polygon over every ring (holes included). */
  function pointInShape(shape, x, y) {
    let inside = false
    for (const polygon of shape) {
      const [x0, y0, x1, y1] = ringBox(polygon[0])
      if (x < x0 || x > x1 || y < y0 || y > y1) continue
      for (const ring of polygon) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i]
          const [xj, yj] = ring[j]
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
        }
      }
    }
    return inside
  }

  /** Crop one closed ring to a rectangle (Sutherland–Hodgman); null if nothing is left. */
  function cropRing(ring, x0, y0, x1, y1) {
    const edges = [
      [(p) => p[0] >= x0, (p, q) => [x0, p[1] + ((q[1] - p[1]) * (x0 - p[0])) / (q[0] - p[0])]],
      [(p) => p[0] <= x1, (p, q) => [x1, p[1] + ((q[1] - p[1]) * (x1 - p[0])) / (q[0] - p[0])]],
      [(p) => p[1] >= y0, (p, q) => [p[0] + ((q[0] - p[0]) * (y0 - p[1])) / (q[1] - p[1]), y0]],
      [(p) => p[1] <= y1, (p, q) => [p[0] + ((q[0] - p[0]) * (y1 - p[1])) / (q[1] - p[1]), y1]],
    ]
    let output = ring.slice(0, -1)
    for (const [inside, cross] of edges) {
      const input = output
      output = []
      for (let j = 0; j < input.length; j++) {
        const p = input[j]
        const q = input[(j + 1) % input.length]
        if (inside(q)) {
          if (!inside(p)) output.push(cross(p, q))
          output.push(q)
        } else if (inside(p)) {
          output.push(cross(p, q))
        }
      }
      if (!output.length) return null
    }
    if (output.length < 3) return null
    output.push(output[0])
    return output
  }

  /** The part of a state outline inside a rectangle, as MultiPolygon coordinates. */
  function cropToBox(shape, x0, y0, x1, y1) {
    const overlaps = (ring) => {
      const [bx0, by0, bx1, by1] = ringBox(ring)
      return !(bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1)
    }
    const out = []
    for (const [outer, ...holes] of shape) {
      if (!overlaps(outer)) continue
      const cropped = cropRing(outer, x0, y0, x1, y1)
      if (!cropped) continue
      const croppedHoles = holes.filter(overlaps).map((h) => cropRing(h, x0, y0, x1, y1)).filter(Boolean)
      out.push([cropped, ...croppedHoles])
    }
    return out
  }

  const stats = {}
  const catchments = buildCatchments()

  // Legend table: lookup points per class, and the job locations the jobs data labels with that class.
  // (Insular territories have no lookup points; the plugin labels them by territory.)
  const jobCounts = {}
  const LABEL_TO_CLASS = { urban: "U", rural: "R", "highly-rural": "H", insular: "I" }
  for (const { properties: p } of jobs.features) {
    const c = LABEL_TO_CLASS[p.rurality] || "X"
    jobCounts[c] = (jobCounts[c] || 0) + p.jobs
  }
  const fmt = (n) => (n || 0).toLocaleString()
  const rows = Object.entries(CLASSES)
    .filter(([key]) => counts[key] || jobCounts[key])
    .map(
      ([key, { label, color }]) => `<tr>
        <td><span class="swatch" style="background:${color}"></span>${label}</td>
        <td class="num">${fmt(counts[key])}</td>
        <td class="num">${fmt(jobCounts[key])}</td>
      </tr>`,
    )
  document.getElementById("legend").innerHTML =
    `<table><thead><tr><th>Class</th><th class="num">Points</th><th class="num">Jobs</th></tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table>`

  // Job pins: the outline of src/assets/job-marker.svg with a white edge and center, one image per
  // rurality class, colored like the lookup points (job-pin-U, job-pin-R, ...).
  const JOB_CLASS = { urban: "U", rural: "R", "highly-rural": "H", insular: "I" }
  const pinImages = {}
  for (const [key, { color }] of Object.entries(CLASSES)) {
    const image = new Image(40, 50)
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="-3 -3 46 56">
        <path d="M20 0C27.74 0 34 6.26 34 14C34 24.5 20 40 20 40C20 40 6 24.5 6 14C6 6.26 12.26 0 20 0Z"
          fill="${color}" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>
        <circle cx="20" cy="14" r="5" fill="#ffffff"/>
      </svg>`,
    )
    pinImages[key] = image
  }
  await Promise.all(Object.values(pinImages).map((image) => image.decode()))

  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/light-v11",
    center: [-98, 39],
    zoom: 3.4,
  })
  map.addControl(new mapboxgl.NavigationControl(), "top-right")
  window.ruralityMap = map // for poking at layers from the console

  const colorExpr = ["match", ["get", "c"], ...Object.entries(CLASSES).flatMap(([k, v]) => [k, v.color]), "#000"]

  map.on("load", () => {
    for (const [key, image] of Object.entries(pinImages)) map.addImage(`job-pin-${key}`, image, { pixelRatio: 2 })
    map.addSource("catchment", { type: "geojson", data: { type: "FeatureCollection", features: catchments } })
    map.addLayer({
      id: "catchment",
      type: "fill",
      source: "catchment",
      paint: { "fill-color": colorExpr, "fill-opacity": 0.28 },
    })
    map.addLayer({
      id: "catchment-outline",
      type: "line",
      source: "catchment",
      minzoom: 6,
      paint: { "line-color": colorExpr, "line-width": 0.6, "line-opacity": 0.7 },
    })

    map.addSource("rurality", { type: "geojson", data: { type: "FeatureCollection", features } })
    map.addLayer({
      id: "rurality",
      type: "circle",
      source: "rurality",
      paint: {
        "circle-color": colorExpr,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.5, 7, 3.5, 11, 6],
        "circle-opacity": 0.85,
      },
    })

    map.addSource("jobs", { type: "geojson", data: jobs })
    map.addLayer({
      id: "jobs",
      type: "symbol",
      source: "jobs",
      filter: ["!=", ["get", "rurality"], "unknown"],
      layout: {
        "icon-image": ["concat", "job-pin-", ["match", ["get", "rurality"], ...Object.entries(JOB_CLASS).flat(), "X"]],
        "icon-anchor": "bottom", // pin tip sits on the job coordinate
        "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 1, 7, 1.4, 11, 1.7],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    })

    const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false })
    for (const layer of ["jobs"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"))
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = ""
        popup.remove()
      })
    }
    map.on("mousemove", "jobs", (e) => {
      const p = e.features[0].properties
      const jobsText = `${p.jobs} job location${p.jobs === 1 ? "" : "s"}`
      popup.setLngLat(e.lngLat)
        .setHTML(`<strong>${p.name}</strong><br>${jobsText} · ${p.rurality}`)
        .addTo(map)
    })
  })
})()
