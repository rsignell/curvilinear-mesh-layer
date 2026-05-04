import { Layer, picking, project32 } from '@deck.gl/core';
import { Geometry, Model } from '@luma.gl/engine';

const TRIANGLE_LAYER_VERTEX_SHADER = `#version 300 es
#define SHADER_NAME curvilinear-triangle-layer-vertex-shader

in vec3 positions;
in vec4 colors;
in vec3 pickingColors;

out vec4 vColor;

void main(void) {
  geometry.worldPosition = positions;
  geometry.pickingColor = pickingColors;
  gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vColor = vec4(colors.rgb, colors.a * layer.opacity);
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

const TRIANGLE_LAYER_FRAGMENT_SHADER = `#version 300 es
#define SHADER_NAME curvilinear-triangle-layer-fragment-shader
precision highp float;

in vec4 vColor;
out vec4 fragColor;

void main(void) {
  if (vColor.a <= 0.0) {
    discard;
  }
  fragColor = vColor;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

class CurvilinearTriangleLayer extends Layer {
  getShaders() {
    return super.getShaders({
      vs: TRIANGLE_LAYER_VERTEX_SHADER,
      fs: TRIANGLE_LAYER_FRAGMENT_SHADER,
      modules: [project32, picking],
    });
  }

  initializeState() {
    this.setState({ model: null });
  }

  updateState(params) {
    super.updateState(params);
    const { props, oldProps, changeFlags } = params;

    if (props.data !== oldProps.data || changeFlags.extensionsChanged) {
      this.state.model?.destroy();
      this.setState({ model: this._buildModel(props.data) });
    }
  }

  _buildModel(data) {
    if (!data?.vertexCount) return null;

    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      geometry: new Geometry({
        topology: 'triangle-list',
        vertexCount: data.vertexCount,
        attributes: {
          positions: { value: data.positions, size: 3 },
          colors: { value: data.colors, size: 4, normalized: true },
          pickingColors: { value: data.pickingColors, size: 3 },
        },
      }),
      isInstanced: false,
    });
  }

  draw() {
    this.state.model?.draw(this.context.renderPass);
  }

  getPickingInfo(params) {
    const info = super.getPickingInfo(params);
    if (info.index >= 0 && this.props.data?.cellValues) {
      info.object = {
        index: info.index,
        value: this.props.data.cellValues[info.index],
      };
    }
    return info;
  }

  finalizeState() {
    this.state.model?.destroy();
    this.setState({ model: null });
  }
}

function buildTriangleLayer(tessellation, id = 'curvilinear-triangle-mesh') {
  return new CurvilinearTriangleLayer({
    id,
    data: tessellation,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 80],
  });
}

export { CurvilinearTriangleLayer, buildTriangleLayer };
