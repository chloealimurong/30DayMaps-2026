// day 9
const SUB_URL = "https://services5.arcgis.com/HDRa0B57OVrv2E1q/ArcGIS/rest/services/Electric_Substations/FeatureServer/0";
const CITY_URL = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Major_Cities_/FeatureServer/0";

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const data = await res.json();
  if (data.error) throw new Error(`ArcGIS error ${data.error.code}: ${data.error.message} (${url})`);
  return data;
}

async function fetchAll(layerUrl, { fields = "*", where = "1=1", pageSize = 1000, batch = 6 } = {}) {
  const q = (extra) => `${layerUrl}/query?` + new URLSearchParams({
    where, outFields: fields, outSR: 4326, f: "geojson",
    geometryPrecision: 3, ...extra,
  });

  const { count } = await getJSON(q({ returnCountOnly: true, f: "json" }));
  console.log(`${layerUrl} -> ${count} features`);
  if (!Number.isFinite(count)) throw new Error("No count returned for " + layerUrl);

  const offsets = Array.from({ length: Math.ceil(count / pageSize) }, (_, i) => i * pageSize);
  const features = [];
  for (let i = 0; i < offsets.length; i += batch) {
    const pages = await Promise.all(offsets.slice(i, i + batch).map(async (o) => {
      const d = await getJSON(q({ resultOffset: o, resultRecordCount: pageSize, orderByFields: "OBJECTID" }));
      return d.features ?? [];
    }));
    features.push(...pages.flat());
  }
  return features;
}