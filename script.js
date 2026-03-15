// ─────────────────────────────────────────────────────────────────────────────
//  Food Services Locator – script.js
//  Two separate search bars:
//    • #search-keyword  → live keyword filter (name / address / about)
//    • #search-location → live geocode suggestions dropdown + org name suggestions
//
//  IMPORTANT: The suggestions dropdown (#location-suggestions) is appended to
//  <body> and positioned with fixed coords so the sidebar's overflow:hidden
//  never clips it.
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRNHg0rCbh8jImJ7M6bt72hmeBG6FahQFc6tfGvMnHCy-kmsodbiOmUP_VI3zyPyzzIYtb4wQvAxK7m/pub?gid=1871557184&single=true&output=csv";

// ── Map setup ──────────────────────────────────────────────────
const map = L.map("map", { maxZoom: 18 }).setView([37.328928, -121.911259], 11);
const markerCluster = L.markerClusterGroup({
  iconCreateFunction(cluster) {
    const count = cluster.getChildCount();
    const size = count < 10 ? "small" : count < 50 ? "medium" : "large";
    const dim = size === "small" ? 36 : size === "medium" ? 44 : 54;
    return L.divIcon({
      html: `<div class="custom-cluster ${size}">${count}</div>`,
      className: "",
      iconSize: L.point(dim, dim),
    });
  },
  maxClusterRadius: 50,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
});
map.addLayer(markerCluster);

L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  {
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012",
  },
).addTo(map);

// Direct Nominatim geocoding — no library wrapper needed
async function nominatimGeocode(query) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    addressdetails: "1",
    limit: "5",
    countrycodes: "us",
  });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "Accept-Language": "en" },
    });
    const data = await res.json();
    return data.map((r) => ({
      name: r.display_name,
      center: L.latLng(parseFloat(r.lat), parseFloat(r.lon)),
    }));
  } catch (e) {
    console.error("Geocode error:", e);
    return [];
  }
}

// ── State ──────────────────────────────────────────────────────
let locations = [];
let markers = [];
let centerPoint = null;
let radiusCircle = null;
let userMarker = null;
let activeSuggestionIndex = -1;
let keywordDebounce = null;
let locationDebounce = null;

// ── Create body-level dropdown elements ───────────────────────
// Location bar dropdown
const dropdown = document.createElement("div");
dropdown.id = "location-suggestions";
dropdown.className = "sugg-dropdown";
dropdown.style.display = "none";
document.body.appendChild(dropdown);

// Keyword bar dropdown
const kwDropdown = document.createElement("div");
kwDropdown.id = "keyword-suggestions";
kwDropdown.className = "sugg-dropdown";
kwDropdown.style.display = "none";
document.body.appendChild(kwDropdown);

// ── Haversine ──────────────────────────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Load data ──────────────────────────────────────────────────
Papa.parse(SHEET_URL, {
  download: true,
  header: true,
  skipEmptyLines: true,
  complete(results) {
    locations = results.data
      .map((r) => ({
        name: (r.Organization_Name || "").trim(),
        address: (r.Address || "").trim(),
        city: (r.City || "").trim(),
        phone: (r.Phone_Number || "").trim(),
        lat: parseFloat(r.Latitude),
        lng: parseFloat(r.Longitude),
        about: (r.About || "").trim(),
        website: (r.Website || "").trim(),
        services_offered: (r.Services_Offered || "").toLowerCase().trim(),
        services_offered_raw: (r.Services_Offered || "").trim(),
        locations_served: (r.Locations_Served || "").toLowerCase().trim(),
        locations_served_raw: (r.Locations_Served || "").trim(),
        days: (r.Grocery_Distribution || "").trim(),
        parent_org: (r.Parent_Organization || "").trim(),
      }))
      .filter((l) => !isNaN(l.lat) && !isNaN(l.lng));
    buildServiceFilters();
    buildAreasFilter();
    buildParentOrgFilter();
    applyFilters();
  },
  error(err) {
    console.error("Error loading data:", err);
    document.getElementById("locationList").innerHTML =
      '<div class="state-msg"><span class="emoji">⚠️</span>Could not load data.<br>Please refresh the page.</div>';
  },
});

// ── Shared: case-insensitive dedup helper ─────────────────────
// Given an array of raw strings (possibly comma/semicolon-separated),
// returns sorted unique values preserving the first-seen casing.
function uniqueValues(rawList) {
  const seen = new Map(); // normalized lowercase key → preferred casing
  rawList.forEach((raw) => {
    if (!raw) return;
    raw.split(/[,;]/)
      .map((s) => s.trim().replace(/\s+/g, " ")) // collapse internal spaces
      .filter(Boolean)
      .forEach((s) => {
        const key = s.toLowerCase();
        if (!seen.has(key)) seen.set(key, s);
      });
  });
  return [...seen.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

// ── Shared: build a checkbox group dynamically ─────────────────
function buildCheckboxGroup(containerId, values, cssClass) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (values.length === 0) {
    container.innerHTML = '<p style="font-size:0.78rem;color:var(--text-muted);padding:4px 0">No data found.</p>';
    return;
  }
  values.forEach((val) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = cssClass;
    cb.value = val;
    cb.addEventListener("change", applyFilters);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + val));
    container.appendChild(label);
  });
}

// ── Dynamic filter builders ────────────────────────────────────
function buildServiceFilters() {
  const values = uniqueValues(locations.map((l) => l.services_offered_raw));
  buildCheckboxGroup("serviceFilters", values, "service-filter");
}

function buildAreasFilter() {
  const values = uniqueValues(locations.map((l) => l.locations_served_raw));
  buildCheckboxGroup("areasFilters", values, "locationFilter");
}

function buildParentOrgFilter() {
  // Each parent_org is a single value (not comma-separated), 
  // but may have trailing spaces — normalize via uniqueValues
  const values = uniqueValues(
    locations
      .map((l) => l.parent_org)
      .filter(Boolean)
      .map((v) => v.trim())
  );
  buildCheckboxGroup("parentOrgFilters", values, "parentOrgFilter");
}

// ── Suggestions helpers ────────────────────────────────────────

function positionDropdown() {
  const input = document.getElementById("search-location");
  const rect = input.getBoundingClientRect();
  dropdown.style.position = "fixed";
  dropdown.style.top = rect.bottom + 4 + "px";
  dropdown.style.left = rect.left + "px";
  dropdown.style.width = rect.width + "px";
}

function hideSuggestions() {
  dropdown.style.display = "none";
  dropdown.innerHTML = "";
  activeSuggestionIndex = -1;
}

function hideKeywordSuggestions() {
  kwDropdown.style.display = "none";
  kwDropdown.innerHTML = "";
}

function positionKeywordDropdown() {
  const input = document.getElementById("search-keyword");
  const rect = input.getBoundingClientRect();
  kwDropdown.style.position = "fixed";
  kwDropdown.style.top = rect.bottom + 4 + "px";
  kwDropdown.style.left = rect.left + "px";
  kwDropdown.style.width = rect.width + "px";
}

function renderKeywordSuggestions(orgs) {
  kwDropdown.innerHTML = "";

  if (!orgs.length) {
    kwDropdown.style.display = "none";
    return;
  }

  positionKeywordDropdown();

  orgs.forEach((loc) => {
    const item = document.createElement("div");
    item.className = "sugg-item sugg-org";
    item.innerHTML =
      `<span class="sugg-icon">🏢</span>` +
      `<span class="sugg-text">${escHtml(loc.name)}` +
      `<span class="sugg-addr">${escHtml(loc.address)}</span></span>`;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      document.getElementById("search-keyword").value = loc.name;
      hideKeywordSuggestions();
      applyFilters();
      // Fly to and open this org's marker
      map.flyTo([loc.lat, loc.lng], 15, { duration: 0.8 });
      setTimeout(() => {
        const idx = locations.findIndex(
          (l) => l.lat === loc.lat && l.lng === loc.lng && l.name === loc.name
        );
        if (idx !== -1 && markers[idx]) markers[idx].openPopup();
        const items = document.querySelectorAll(".location-item");
        items.forEach((i) => i.classList.remove("active"));
        if (items[idx]) {
          items[idx].classList.add("active");
          items[idx].scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        switchTab("results");
      }, 500);
    });
    kwDropdown.appendChild(item);
  });

  kwDropdown.style.display = "block";
}

function renderSuggestions(locResults, orgResults) {
  dropdown.innerHTML = "";
  activeSuggestionIndex = -1;

  if (!locResults.length && !orgResults.length) {
    dropdown.style.display = "none";
    return;
  }

  positionDropdown();

  // ── Geocoded location results ──
  if (locResults.length) {
    const label = document.createElement("div");
    label.className = "sugg-group-label";
    label.textContent = "Locations";
    dropdown.appendChild(label);

    locResults.forEach((r) => {
      const item = document.createElement("div");
      item.className = "sugg-item sugg-location";
      item.innerHTML =
        `<span class="sugg-icon">📍</span>` +
        `<span class="sugg-text">${escHtml(r.name)}</span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickLocation(r);
      });
      dropdown.appendChild(item);
    });
  }

  // ── Org results ──
  if (orgResults.length) {
    if (locResults.length) {
      const sep = document.createElement("div");
      sep.className = "sugg-sep";
      dropdown.appendChild(sep);
    }

    const label = document.createElement("div");
    label.className = "sugg-group-label";
    label.textContent = "Organizations";
    dropdown.appendChild(label);

    orgResults.forEach((loc) => {
      const item = document.createElement("div");
      item.className = "sugg-item sugg-org";
      item.innerHTML =
        `<span class="sugg-icon">🏢</span>` +
        `<span class="sugg-text">${escHtml(loc.name)}` +
        `<span class="sugg-addr">${escHtml(loc.address)}</span></span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickOrg(loc);
      });
      dropdown.appendChild(item);
    });
  }

  dropdown.style.display = "block";
}

function pickLocation(result) {
  centerPoint = L.latLng(result.center.lat, result.center.lng);
  document.getElementById("search-location").value = result.name;
  hideSuggestions();
  map.setView(centerPoint, 13);
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker(centerPoint, {
    icon: L.divIcon({
      className: "",
      html: `<div class="you-are-here-pin search-pin"><div class="yah-pulse"></div><div class="yah-dot"></div></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    }),
  })
    .addTo(map)
    .bindPopup(`
      <div class="popup-card yah-popup">
        <div class="popup-header yah-header">
          <div class="yah-icon-wrap">🔍</div>
          <div class="popup-title">${escHtml(result.name)}</div>
        </div>
        <div class="popup-body yah-body">
          <div class="yah-note">Showing results near this location</div>
        </div>
      </div>
    `, { maxWidth: 220 })
    .openPopup();
  applyFilters();
}

function pickOrg(loc) {
  document.getElementById("search-location").value = loc.name;
  hideSuggestions();
  map.flyTo([loc.lat, loc.lng], 15, { duration: 0.8 });
  setTimeout(() => {
    const idx = locations.findIndex(
      (l) => l.lat === loc.lat && l.lng === loc.lng && l.name === loc.name,
    );
    if (idx !== -1 && markers[idx]) markers[idx].openPopup();
    const items = document.querySelectorAll(".location-item");
    items.forEach((i) => i.classList.remove("active"));
    if (items[idx]) {
      items[idx].classList.add("active");
      items[idx].scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    switchTab("results");
  }, 500);
}

// Keyboard navigation inside the location dropdown
function handleLocationKeydown(e) {
  const items = dropdown.querySelectorAll(".sugg-item");
  if (!items.length && e.key !== "Enter") return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, items.length - 1);
    items.forEach((i, idx) => i.classList.toggle("sugg-active", idx === activeSuggestionIndex));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, -1);
    items.forEach((i, idx) => i.classList.toggle("sugg-active", idx === activeSuggestionIndex));
  } else if (e.key === "Enter") {
    if (activeSuggestionIndex >= 0 && items[activeSuggestionIndex]) {
      e.preventDefault();
      items[activeSuggestionIndex].dispatchEvent(new Event("mousedown"));
    } else {
      // Plain Enter — geocode the raw typed value
      hideSuggestions();
      const q = document.getElementById("search-location").value.trim();
      if (q) {
        nominatimGeocode(q).then((results) => {
          if (results.length > 0) {
            pickLocation(results[0]);
          } else {
            alert("Location not found. Please try a different address or ZIP code.");
          }
        });
      }
    }
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
}

// ── Accordion ─────────────────────────────────────────────────
function toggleAccordion(btn) {
  const body = btn.nextElementSibling;
  const isOpen = btn.classList.contains("open");
  btn.classList.toggle("open", !isOpen);
  body.classList.toggle("open", !isOpen);
}

function updateAccordionBadges() {
  // Services
  const servCount = document.querySelectorAll(".service-filter:checked").length;
  const servBadge = document.getElementById("acc-badge-services");
  servBadge.textContent = servCount || "";
  servBadge.classList.toggle("visible", servCount > 0);

  // Days
  const dayCount = document.querySelectorAll(".dayFilter:checked").length;
  const dayBadge = document.getElementById("acc-badge-days");
  dayBadge.textContent = dayCount || "";
  dayBadge.classList.toggle("visible", dayCount > 0);

  // Areas
  const areaCount = document.querySelectorAll(".locationFilter:checked").length;
  const areaBadge = document.getElementById("acc-badge-areas");
  areaBadge.textContent = areaCount || "";
  areaBadge.classList.toggle("visible", areaCount > 0);

  // Parent Org
  const parentCount = document.querySelectorAll(".parentOrgFilter:checked").length;
  const parentBadge = document.getElementById("acc-badge-parent");
  if (parentBadge) {
    parentBadge.textContent = parentCount || "";
    parentBadge.classList.toggle("visible", parentCount > 0);
  }

  // Radius
  const radius = parseFloat(document.getElementById("radius").value);
  const radBadge = document.getElementById("acc-badge-radius");
  radBadge.textContent = radius > 0 ? `${radius} mi` : "";
  radBadge.classList.toggle("visible", radius > 0);
}

// ── Filters ────────────────────────────────────────────────────
function applyFilters() {
  const term = document.getElementById("search-keyword").value.toLowerCase().trim();
  const radius = parseFloat(document.getElementById("radius").value);
  const checkedServs = [...document.querySelectorAll(".service-filter:checked")].map((cb) => cb.value);
  const checkedDays = [...document.querySelectorAll(".dayFilter:checked")].map((cb) => cb.value);
  const checkedLocs = [...document.querySelectorAll(".locationFilter:checked")].map((cb) => cb.value);
  const checkedParents = [...document.querySelectorAll(".parentOrgFilter:checked")].map((cb) => cb.value);

  let filtered = locations.filter((l) => {
    if (
      term &&
      !l.name.toLowerCase().includes(term) &&
      !l.address.toLowerCase().includes(term) &&
      !l.about.toLowerCase().includes(term)
    )
      return false;

    if (checkedServs.length && !checkedServs.some((s) => l.services_offered.includes(s.toLowerCase())))
      return false;

    if (checkedDays.length && !checkedDays.some((d) => l.days.toLowerCase().includes(d.toLowerCase())))
      return false;

    if (checkedLocs.length && !checkedLocs.some((loc) => l.locations_served.includes(loc.toLowerCase())))
      return false;

    if (checkedParents.length && !checkedParents.some((p) => l.parent_org.trim().toLowerCase() === p.trim().toLowerCase()))
      return false;

    if (centerPoint && radius > 0) {
      const dist = haversineDistance(centerPoint.lat, centerPoint.lng, l.lat, l.lng);
      if (dist > radius) return false;
    }

    return true;
  });

  // Sort: by distance if center point active, otherwise alphabetically
  if (centerPoint) {
    filtered = filtered
      .map((l) => ({
        ...l,
        _dist: haversineDistance(centerPoint.lat, centerPoint.lng, l.lat, l.lng),
      }))
      .sort((a, b) => a._dist - b._dist);
  } else {
    filtered = filtered.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  renderLocations(filtered);
  updateAccordionBadges();
}

// ── Reset ──────────────────────────────────────────────────────
function resetFilters() {
  document.getElementById("search-keyword").value = "";
  document.getElementById("search-location").value = "";
  document.getElementById("radius").value = 0;
  document.getElementById("radiusValue").textContent = 0;
  document.querySelectorAll(".service-filter, .dayFilter, .locationFilter, .parentOrgFilter").forEach((cb) => (cb.checked = false));
  centerPoint = null;
  hideSuggestions();
  hideKeywordSuggestions();
  if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
  if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
  applyFilters();
}

// ── Tabs ──────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("panel-filters").style.display = tab === "filters" ? "flex" : "none";
  document.getElementById("panel-results").style.display = tab === "results" ? "flex" : "none";
  document.getElementById("tab-filters").classList.toggle("active", tab === "filters");
  document.getElementById("tab-results").classList.toggle("active", tab === "results");
}

// ── Render locations ──────────────────────────────────────────
function renderLocations(data) {
  markerCluster.clearLayers();
  markers = [];

  const list = document.getElementById("locationList");
  list.innerHTML = "";

  document.getElementById("resultCount").textContent = data.length === 0 ? "0" : `${data.length}`;

  if (data.length === 0) {
    list.innerHTML =
      '<div class="state-msg"><span class="emoji">🔍</span>No locations match your filters.<br>Try adjusting your search.</div>';
    return;
  }

  data.forEach((loc) => {
    const pinIcon = L.divIcon({
      className: "",
      html: `<div class="loc-pin"><div class="loc-pin-head"></div><div class="loc-pin-shadow"></div></div>`,
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -36],
    });
    const marker = L.marker([loc.lat, loc.lng], { icon: pinIcon });
    markerCluster.addLayer(marker);

    marker.bindPopup(`
      <div class="popup-card">
        <div class="popup-header">
          <div class="popup-title">${escHtml(loc.name)}</div>
        </div>
        <div class="popup-body">
          <div class="popup-section">
            <strong>📍 Address</strong>${escHtml(loc.address)}
          </div>
          ${loc.phone ? `<div class="popup-section"><strong>📞 Phone</strong>${escHtml(loc.phone)}</div>` : ""}
          ${loc.parent_org ? `<div class="popup-section"><strong>🏛 Parent Organization</strong>${escHtml(loc.parent_org)}</div>` : ""}
          ${loc.about ? `<div class="popup-section"><strong>ℹ️ About</strong>${escHtml(loc.about)}</div>` : ""}
          ${loc.services_offered ? `<div class="popup-section"><strong>🛠 Services</strong>${escHtml(loc.services_offered)}</div>` : ""}
          ${loc.locations_served ? `<div class="popup-section"><strong>📌 Areas Served</strong>${escHtml(loc.locations_served)}</div>` : ""}
          ${loc.days ? `<div class="popup-section"><strong>📅 Distribution Days</strong>${escHtml(loc.days)}</div>` : ""}
          <div class="popup-actions">
            ${loc.website ? `<a class="popup-button" href="${loc.website}" target="_blank" rel="noopener noreferrer">Visit Website ↗</a>` : ""}
            <a class="popup-button popup-button--directions"
              href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(loc.address)}"
              target="_blank" rel="noopener noreferrer">🗺 Get Directions ↗</a>
          </div>
        </div>
      </div>
    `);
    markers.push(marker);

    const distBadge = loc._dist !== undefined
      ? `<span class="item-dist">${loc._dist < 0.1 ? "< 0.1" : loc._dist.toFixed(1)} mi</span>`
      : "";
    const div = document.createElement("div");
    div.className = "location-item";
    div.innerHTML = `<div class="item-header"><div class="item-name">${escHtml(loc.name)}</div>${distBadge}</div><div class="item-addr">${escHtml(loc.address)}</div>`;

    div.onclick = () => {
      document.querySelectorAll(".location-item").forEach((i) => i.classList.remove("active"));
      div.classList.add("active");
      // zoomToShowLayer ensures the marker is unclustered before opening the popup
      markerCluster.zoomToShowLayer(marker, () => {
        marker.openPopup();
      });
    };

    marker.on("click", () => {
      switchTab("results");
      document.querySelectorAll(".location-item").forEach((i) => i.classList.remove("active"));
      div.classList.add("active");
      div.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    list.appendChild(div);
  });

  // Always fit map to visible results
  if (markers.length > 0) {
    const bounds = markerCluster.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.12), { maxZoom: centerPoint ? 14 : 13 });
    }
  }
}

// ── XSS helper ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Locate user ─────────────────────────────────────────────────
function locateUser() {
  map.locate({ setView: true, maxZoom: 13 });
}

map.on("locationfound", (e) => {
  centerPoint = e.latlng;
  document.getElementById("search-location").value = "📍 Current Location";
  hideSuggestions();
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker(centerPoint, {
    icon: L.divIcon({
      className: "",
      html: `<div class="you-are-here-pin"><div class="yah-pulse"></div><div class="yah-dot"></div></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    }),
  })
    .addTo(map)
    .bindPopup(`
      <div class="popup-card yah-popup">
        <div class="popup-header yah-header">
          <div class="yah-icon-wrap">📍</div>
          <div class="popup-title">You are here</div>
        </div>
        <div class="popup-body yah-body">
          <div class="yah-coords">${centerPoint.lat.toFixed(5)}, ${centerPoint.lng.toFixed(5)}</div>
          <div class="yah-note">Showing results near your location</div>
        </div>
      </div>
    `, { maxWidth: 220 })
    .openPopup();
  applyFilters();
});

map.on("locationerror", () => {
  alert("Could not determine your location. Please check your browser permissions.");
});

// ── Event listeners ────────────────────────────────────────────

// Keyword bar — live filter + org name suggestions
document.getElementById("search-keyword").addEventListener("input", function () {
  const val = this.value.trim();
  clearTimeout(keywordDebounce);

  if (!val) {
    hideKeywordSuggestions();
    applyFilters();
    return;
  }

  keywordDebounce = setTimeout(() => {
    applyFilters();
    const term = val.toLowerCase();
    const orgMatches = locations
      .filter((l) => l.name.toLowerCase().includes(term))
      .slice(0, 6);
    renderKeywordSuggestions(orgMatches);
  }, 250);
});

document.getElementById("search-keyword").addEventListener("keydown", function (e) {
  const items = kwDropdown.querySelectorAll(".sugg-item");
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const next = Math.min((parseInt(kwDropdown.dataset.active ?? "-1")) + 1, items.length - 1);
    items.forEach((i, idx) => i.classList.toggle("sugg-active", idx === next));
    kwDropdown.dataset.active = next;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const prev = Math.max((parseInt(kwDropdown.dataset.active ?? "0")) - 1, -1);
    items.forEach((i, idx) => i.classList.toggle("sugg-active", idx === prev));
    kwDropdown.dataset.active = prev;
  } else if (e.key === "Enter") {
    const active = parseInt(kwDropdown.dataset.active ?? "-1");
    if (active >= 0 && items[active]) {
      e.preventDefault();
      items[active].dispatchEvent(new Event("mousedown"));
    } else {
      hideKeywordSuggestions();
    }
  } else if (e.key === "Escape") {
    hideKeywordSuggestions();
  }
});

// Dismiss keyword suggestions on outside click
document.addEventListener("click", (e) => {
  if (
    !e.target.closest("#search-keyword") &&
    !e.target.closest("#keyword-suggestions")
  ) {
    hideKeywordSuggestions();
  }
});

// Location bar — live geocode + org suggestions
document.getElementById("search-location").addEventListener("input", function () {
  const val = this.value.trim();

  if (!val) {
    centerPoint = null;
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    hideSuggestions();
    applyFilters();
    return;
  }

  clearTimeout(locationDebounce);
  locationDebounce = setTimeout(() => {
    const term = val.toLowerCase();

    // Org matches from loaded dataset
    const orgMatches = locations
      .filter((l) => l.name.toLowerCase().includes(term))
      .slice(0, 4);

    // Geocode for place suggestions
    nominatimGeocode(val).then((results) => {
      renderSuggestions(results.slice(0, 3), orgMatches);
    });
  }, 300);
});

document.getElementById("search-location").addEventListener("keydown", handleLocationKeydown);

// Keep dropdown aligned on resize
window.addEventListener("resize", () => {
  if (dropdown.style.display === "block") positionDropdown();
});

// Dismiss on outside click
document.addEventListener("click", (e) => {
  if (
    !e.target.closest("#search-location") &&
    !e.target.closest("#location-suggestions")
  ) {
    hideSuggestions();
  }
});

document.getElementById("radius").addEventListener("input", function () {
  document.getElementById("radiusValue").textContent = this.value;
  applyFilters();
});

// Static filters (day + area) — service filters get listeners in buildServiceFilters()
document
  .querySelectorAll(".dayFilter, .locationFilter")
  .forEach((cb) => cb.addEventListener("change", applyFilters));