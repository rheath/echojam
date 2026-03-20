declare global {
  namespace google.maps.routes {
    interface ComputeRoutesRequest {
      origin: google.maps.LatLngLiteral;
      destination: google.maps.LatLngLiteral;
      intermediates?: google.maps.LatLngLiteral[];
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
