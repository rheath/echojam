declare global {
  namespace google.maps.routes {
    interface Waypoint {
      location:
        | string
        | google.maps.LatLng
        | google.maps.LatLngLiteral
        | google.maps.LatLngAltitude
        | google.maps.LatLngAltitudeLiteral
        | google.maps.Place;
      via?: boolean;
    }

    interface ComputeRoutesRequest {
      origin: google.maps.LatLngLiteral;
      destination: google.maps.LatLngLiteral;
      intermediates?: Waypoint[];
      travelMode: "BICYCLING" | "DRIVE" | "TRANSIT" | "TWO_WHEELER" | "WALKING";
      fields: string[];
    }

    interface RouteResult {
      path?: google.maps.LatLngAltitude[];
    }

    interface ComputeRoutesResponse {
      routes?: RouteResult[];
    }

    class Route {
      static computeRoutes(
        request: ComputeRoutesRequest
      ): Promise<ComputeRoutesResponse>;
    }
  }
}

export {};
