export default (L, Plugin, Logger) => {
  return class GeoJsonLoader extends Plugin {
    constructor(map, name, options) {
      super(map, name, options);
      this.layer = null;
      this.labelLayer = null;
      this._isMounted = false;
      this.hass = document.querySelector('home-assistant').hass;
    }

    async renderMap() {
      try {
        Logger.debug("[GeoJsonLoader] Initializing plugin");
        this._isMounted = true;

        if (!this.map || !this.map.getContainer()) {
          Logger.warn("[GeoJsonLoader] Map container not available");
          return;
        }

        const geoJsonData = await this._loadGeoJsonData();
        if (!geoJsonData || !this._isMounted) return;

        // Main GeoJSON layer
        this.layer = L.geoJSON(geoJsonData, {
          style: (feature) => this._getFeatureStyle(feature),
                               onEachFeature: (feature, layer) => this._bindFeatureEvents(feature, layer),
                               pointToLayer: (feature, latlng) => {
                                 const type = feature.properties?.type_name;
                                 if (type === "label") return null;
                                 return L.circleMarker(latlng, { radius: 0, opacity: 0 });
                               },
                               filter: (feature) => feature.properties?.type_name !== "path" // Exclude paths from main layer
        });

        if (this._isMounted && this.map.getContainer().parentNode) {
          this.layer.addTo(this.map);
          Logger.debug("[GeoJsonLoader] Layer added successfully");

          // Road base layer
          this.roadLayer = L.geoJSON(geoJsonData, {
            filter: f => f.properties?.type_name === "path",
            style: feature => this._getFeatureStyle(feature)
          });
          this.roadLayer.addTo(this.map);

          // Road overlay layer (center line)
          this.roadOverlayLayer = L.geoJSON(geoJsonData, {
            filter: f => f.properties?.type_name === "path",
            style: feature => ({
              color: feature.properties?.road_center_color || "#000000",
              weight: 2,
              opacity: 1.0,
              dashArray: feature.properties?.dashArray || "8, 8"
            })
          });
          this.roadOverlayLayer.addTo(this.map);


          // Add text labels
          this._addTextLabels(geoJsonData);

        }
      } catch (error) {
        Logger.error("[GeoJsonLoader] Error:", error);
      }
    }

    async _loadGeoJsonData() {
      try {
        if (this.options.url) {
          const response = await fetch(this.options.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.json();
        } else if (this.options.data) {
          return this.options.data;
        }
        throw new Error("No GeoJSON data provided");
      } catch (error) {
        Logger.error("[GeoJsonLoader] Load error:", error);
        return null;
      }
    }

    _bindFeatureEvents(feature, layer) {
      // Add popups or other events if needed later
    }

    _getFeatureStyle(feature) {
      const validStyleProperties = [
        "color", "weight", "opacity", "fillColor", "fillOpacity",
        "dashArray", "lineCap", "lineJoin", "radius"
      ];

      const style = {};
      for (const tag of validStyleProperties) {
        const value = feature.properties?.[tag] || this.options[tag];
        if (value !== undefined) style[tag] = value;
      }
      return style;
    }


    /** Add visible text labels on the map */
    _addTextLabels(geoJsonData) {
      this.labelLayer = L.layerGroup();
      this._labelMarkers = []; // Store references for easier updates

      L.geoJSON(geoJsonData, {
        pointToLayer: (feature, latlng) => {
          let name = feature.properties?.Name || feature.properties?.title;
          name = `${name} ${Math.ceil(feature.properties?.area)}m2`;
          const type = feature.properties?.type_name;
          if (type === "label" && name) {
            const labelMarker = this._createLabelMarker(name, latlng);
            this.labelLayer.addLayer(labelMarker);
            this._labelMarkers.push(labelMarker);
          }
          return null;
        },
        onEachFeature: (feature, layer) => {
          // Handle polygons with Name (no label point)
          if (feature.geometry.type === "Polygon" && feature.properties?.Name) {
            const center = layer.getBounds().getCenter();
            const name = `${feature.properties.Name} ${Math.ceil(feature.properties?.area)}m2`;
            const labelMarker = this._createLabelMarker(name, center);
            this.labelLayer.addLayer(labelMarker);
            this._labelMarkers.push(labelMarker);
          }
        }
      });

      this.labelLayer.addTo(this.map);
    }

    /** Create a label marker */
    _createLabelMarker(text, latlng) {
      const divIcon = L.divIcon({
        className: "geojson-text-label",
        html: `<div class="geojson-label-text" style="font-size: 14px;">${text}</div>`,
        iconSize: null
      });
      return L.marker(latlng, { icon: divIcon, interactive: false });
    }

    /** Adjust label size and visibility when zooming */
    _updateLabelScaling() {
      if (!this._isMounted) return;

      const zoom = this.map.getZoom();
      const scale = Math.min(Math.max((zoom - 10) / 5, 0.5), 2);
      const visible = zoom >= 11;

      // Use cached markers instead of DOM query
      if (this._labelMarkers) {
        this._labelMarkers.forEach(marker => {
          const element = marker.getElement();
          if (element) {
            const textDiv = element.querySelector('.geojson-label-text');
            if (textDiv) {
              textDiv.style.transform = `scale(${scale})`;
              textDiv.style.opacity = visible ? "1" : "0";
            }
          }
        });
      }
    }

    async update() {
      // Implement update logic if needed
    }

    destroy() {
      this._isMounted = false;

      // Remove event listeners
      if (this.map && this._updateRoadStyle) {
        this.map.off("zoomend", this._updateRoadStyle);
      }

      // Clean up layers
      const layers = [this.layer, this.roadLayer, this.roadOverlayLayer, this.labelLayer];
      layers.forEach(layer => {
        if (layer) {
          try {
            layer.remove();
          } catch (e) {
            Logger.debug("[GeoJsonLoader] Cleanup error:", e);
          }
        }
      });

      // Clear references
      this.layer = null;
      this.roadLayer = null;
      this.roadOverlayLayer = null;
      this.labelLayer = null;
      this._labelMarkers = null;
      this._updateRoadStyle = null;
    }
  }
};

