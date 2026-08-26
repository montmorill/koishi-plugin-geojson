declare module 'geojson-bbox' {
  import type { GeoJSON } from 'geojson'

  export default function bbox(geojson: GeoJSON): GeoJSON.BBox
}

declare module 'reproject-spherical-mercator' {
  import type { GeoJSON } from 'geojson'

  export default function reproject<T extends GeoJSON>(geojson: T): T
}
