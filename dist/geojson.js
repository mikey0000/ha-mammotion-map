export default (L, Plugin, Logger) => {
  return class GeoJsonLoader extends Plugin {
    constructor(map, name, options) {
      super(map, name, options);
      this.layer = null;
      this.labelLayer = null;
      this._isMounted = false;
      this.hass = document.querySelector('home-assistant').hass;
      this._rotatedMarkerPlugin();
    }

    async renderMap() {
      try {
        Logger.debug("[GeoJsonLoader] Initializing plugin");
        this._isMounted = true;

        if (!this.map || !this.map.getContainer()) {
          Logger.warn("[GeoJsonLoader] Map container not available");
          return;
        }

        let geoJsonData = await this._loadGeoJsonData();
        if (!geoJsonData || !this._isMounted) return;

        const offsetLat = this.options.offset_lat || 0;
        const offsetLon = this.options.offset_lon || 0;
        if (offsetLat !== 0 || offsetLon !== 0) {
          geoJsonData = this._offsetGeoJson(geoJsonData, offsetLat, offsetLon);
          Logger.debug(`[GeoJsonLoader] Applied offset: ${offsetLat}m north/south, ${offsetLon}m east/west`);
        }

        const rotationDeg = this.options.rotation_deg || 0;
        if (rotationDeg !== 0) {
          const originLat = this.options.rotation_origin_lat ?? 0;
          const originLon = this.options.rotation_origin_lon ?? 0;
          geoJsonData = this._rotateGeoJson(geoJsonData, rotationDeg, originLat, originLon);
          Logger.debug(`[GeoJsonLoader] Applied rotation: ${rotationDeg}° around (${originLat}, ${originLon})`);
}

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


          this.rtk_and_dock = L.geoJSON(geoJsonData, {
            filter: f => !!f.properties?.iconImage,
            style: feature => this._getFeatureStyle(feature),
            pointToLayer: (feature, latlng) => {
              return this._createRotatedMarker(feature, latlng);
            }
          })

          this.rtk_and_dock.addTo(this.map);

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

    _offsetGeoJson(geojson, offsetLatMeters, offsetLonMeters) {
      const degPerMeterLat = 1 / 111320; // ~1 deg latitude = 111.32 km
      const offsetLat = offsetLatMeters * degPerMeterLat;

      // Convert lon offset depends on latitude
      const applyOffset = (coords, latRef) => {
        const degPerMeterLon = 1 / (111320 * Math.cos(latRef * Math.PI / 180));
        const offsetLon = offsetLonMeters * degPerMeterLon;
        return [coords[0] + offsetLon, coords[1] + offsetLat];
      };

      const offsetCoords = (geometry) => {
        if (!geometry) return geometry;
        switch (geometry.type) {
          case "Point":
            return { ...geometry, coordinates: applyOffset(geometry.coordinates, geometry.coordinates[1]) };
          case "LineString":
            return { ...geometry, coordinates: geometry.coordinates.map(c => applyOffset(c, c[1])) };
          case "Polygon":
            return {
              ...geometry,
              coordinates: geometry.coordinates.map(ring =>
                ring.map(c => applyOffset(c, c[1]))
              )
            };
          case "MultiPolygon":
            return {
              ...geometry,
              coordinates: geometry.coordinates.map(poly =>
                poly.map(ring => ring.map(c => applyOffset(c, c[1])))
              )
            };
          case "MultiLineString":
            return {
              ...geometry,
              coordinates: geometry.coordinates.map(line =>
                line.map(c => applyOffset(c, c[1]))
              )
            };
          default:
            return geometry;
        }
      };

      if (geojson.type === "FeatureCollection") {
        return {
          ...geojson,
          features: geojson.features.map(f => ({
            ...f,
            geometry: offsetCoords(f.geometry)
          }))
        };
      } else if (geojson.type === "Feature") {
        return { ...geojson, geometry: offsetCoords(geojson.geometry) };
      } else {
        return offsetCoords(geojson);
      }
    }

    _rotateGeoJson(geojson, rotationDeg, originLat, originLon) {
      const toRad = Math.PI / 180;
      const toDeg = 180 / Math.PI;
      const angle = rotationDeg * toRad;

      // Helper: rotate a single [lon, lat] point
      const rotatePoint = (coords) => {
        const [lon, lat] = coords;

        // Convert to meters (approx)
        const R = 6378137; // Earth radius
        const x = (lon - originLon) * (Math.PI / 180) * R * Math.cos(originLat * toRad);
        const y = (lat - originLat) * (Math.PI / 180) * R;

        // Rotate around origin (0,0)
        const xr = x * Math.cos(angle) - y * Math.sin(angle);
        const yr = x * Math.sin(angle) + y * Math.cos(angle);

        // Convert back to lat/lon
        const newLon = originLon + (xr / (R * Math.cos(originLat * toRad))) * toDeg;
        const newLat = originLat + (yr / R) * toDeg;

        return [newLon, newLat];
      };

      const rotateCoords = (geometry) => {
        if (!geometry) return geometry;
        switch (geometry.type) {
          case "Point":
            return { ...geometry, coordinates: rotatePoint(geometry.coordinates) };
          case "LineString":
            return { ...geometry, coordinates: geometry.coordinates.map(rotatePoint) };
          case "Polygon":
            return {
              ...geometry,
              coordinates: geometry.coordinates.map(ring =>
                ring.map(rotatePoint)
              )
            };
          case "MultiPolygon":
            return {
              ...geometry,
              coordinates: geometry.coordinates.map(poly =>
                poly.map(ring => ring.map(rotatePoint))
              )
            };
          case "MultiLineString":
            return {
              ...geometry,
              coordinates: geometry.coordinates.map(line =>
                line.map(rotatePoint)
              )
            };
          default:
            return geometry;
        }
      };

      if (geojson.type === "FeatureCollection") {
        return {
          ...geojson,
          features: geojson.features.map(f => ({
            ...f,
            geometry: rotateCoords(f.geometry)
          }))
        };
      } else if (geojson.type === "Feature") {
        return { ...geojson, geometry: rotateCoords(geojson.geometry) };
      } else {
        return rotateCoords(geojson);
      }
    }


    _getFeatureStyle(feature) {
      if (feature.geometry?.type === 'Point' && feature.properties?.iconImage) {
        return null;
      }

      const style = {};
      const validStyleProperties = [
        "color", "weight", "opacity", "fillColor",
        "fillOpacity", "dashArray", "lineCap",
        "lineJoin", "radius"
      ];

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

    _createRotatedMarker(feature, latlng) {
      const properties = feature.properties || {};
      const iconUrl = properties.iconUrl || `${properties.iconImage}`;
      const iconSize = properties.iconSize || [30, 30];
      const iconAnchor = properties.iconAnchor || [iconSize[0] / 2, iconSize[1] / 2];
      const rotation = properties.rotation || 0;

      // Option 1: Using L.icon with CSS rotation (works without plugins)
      const icon = L.icon({
        iconUrl: iconUrl,
        iconSize: iconSize,
        iconAnchor: iconAnchor,
        className: 'leaflet-rotated-icon' // Custom class for styling
      });

      const marker = L.marker(latlng, {
        icon: icon,
        rotationAngle: rotation, // This works if leaflet-rotatedmarker plugin is loaded
        rotationOrigin: 'center' // Rotation origin
      });

      return marker;
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

    _rotatedMarkerPlugin() {
      // save these original methods before they are overwritten
      var proto_initIcon = L.Marker.prototype._initIcon;
      var proto_setPos = L.Marker.prototype._setPos;

      var oldIE = (L.DomUtil.TRANSFORM === 'msTransform');

      L.Marker.addInitHook(function () {
        var iconOptions = this.options.icon && this.options.icon.options;
        var iconAnchor = iconOptions && this.options.icon.options.iconAnchor;
        if (iconAnchor) {
          iconAnchor = (iconAnchor[0] + 'px ' + iconAnchor[1] + 'px');
        }
        this.options.rotationOrigin = this.options.rotationOrigin || iconAnchor || 'center bottom' ;
        this.options.rotationAngle = this.options.rotationAngle || 0;

        // Ensure marker keeps rotated during dragging
        this.on('drag', function(e) { e.target._applyRotation(); });
      });

      L.Marker.include({
        _initIcon: function() {
          proto_initIcon.call(this);
        },

        _setPos: function (pos) {
          proto_setPos.call(this, pos);
          this._applyRotation();
        },

        _applyRotation: function () {
          if(this.options.rotationAngle) {
            this._icon.style[L.DomUtil.TRANSFORM+'Origin'] = this.options.rotationOrigin;

            if(oldIE) {
              // for IE 9, use the 2D rotation
              this._icon.style[L.DomUtil.TRANSFORM] = 'rotate(' + this.options.rotationAngle + 'deg)';
            } else {
              // for modern browsers, prefer the 3D accelerated version
              this._icon.style[L.DomUtil.TRANSFORM] += ' rotateZ(' + this.options.rotationAngle + 'deg)';
            }
          }
        },

        setRotationAngle: function(angle) {
          this.options.rotationAngle = angle;
          this.update();
          return this;
        },

        setRotationOrigin: function(origin) {
          this.options.rotationOrigin = origin;
          this.update();
          return this;
        }
      });
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
