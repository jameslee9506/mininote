/** C-like languages the legacy modes lack, as configurations of their `clike` tokenizer. */
import type { StringStream } from "@codemirror/language";
import { clike } from "@codemirror/legacy-modes/mode/clike";

/** `clike` looks words up with `propertyIsEnumerable`, so its word lists are plain objects. */
const words = (list: string): Record<string, true> =>
  Object.fromEntries(list.split(" ").map((word) => [word, true] as const));

interface ClikeState {
  startOfLine: boolean;
}

/** `#include`, `#define`, `#if`…: a whole line of preprocessor text. */
function preprocessor(stream: StringStream, state: ClikeState): string | false {
  if (!state.startOfLine) return false;
  stream.skipToEnd();
  return "meta";
}

/** The shading language of `.gdshader` files: GLSL ES 3.0 with its own declarations and hints. */
export const gdshader = clike({
  name: "gdshader",
  keywords: words(
    "shader_type render_mode uniform varying const in out inout struct return if else for while do switch case " +
      "default break continue discard instance global group_uniforms flat smooth lowp mediump highp",
  ),
  types: words(
    "void bool bvec2 bvec3 bvec4 int ivec2 ivec3 ivec4 uint uvec2 uvec3 uvec4 float vec2 vec3 vec4 mat2 mat3 mat4 " +
      "sampler2D isampler2D usampler2D sampler2DArray isampler2DArray usampler2DArray sampler3D isampler3D " +
      "usampler3D samplerCube samplerCubeArray samplerExternalOES",
  ),
  blockKeywords: words("for while do if else struct switch"),
  builtin: words(
    "radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh pow exp exp2 log log2 sqrt " +
      "inversesqrt abs sign floor trunc round roundEven ceil fract mod modf min max clamp mix step smoothstep " +
      "isnan isinf fma length distance dot cross normalize reflect refract faceforward matrixCompMult outerProduct " +
      "transpose determinant inverse lessThan greaterThan lessThanEqual greaterThanEqual equal notEqual any all " +
      "not textureSize textureQueryLod textureQueryLevels texture textureProj textureLod textureProjLod " +
      "textureGrad textureProjGrad textureGather texelFetch dFdx dFdy fwidth floatBitsToInt floatBitsToUint " +
      "intBitsToFloat uintBitsToFloat bitfieldExtract bitfieldInsert bitfieldReverse bitCount findLSB findMSB " +
      "source_color hint_range hint_enum hint_normal hint_default_white hint_default_black " +
      "hint_default_transparent hint_anisotropy hint_roughness_r hint_roughness_g hint_roughness_b " +
      "hint_roughness_a hint_roughness_normal hint_roughness_gray hint_screen_texture hint_depth_texture " +
      "hint_normal_roughness_texture filter_nearest filter_linear filter_nearest_mipmap filter_linear_mipmap " +
      "filter_nearest_mipmap_anisotropic filter_linear_mipmap_anisotropic repeat_enable repeat_disable " +
      "instance_index",
  ),
  atoms: words("true false"),
  hooks: { "#": preprocessor },
});

/** PHP source. Markup outside `<?php … ?>` is read as PHP too, which a viewer can live with. */
export const php = clike({
  name: "php",
  keywords: words(
    "abstract and array as break callable case catch class clone const continue declare default do echo else " +
      "elseif enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach " +
      "function global goto if implements include include_once instanceof insteadof interface isset list match " +
      "namespace new or print private protected public readonly require require_once return static switch throw " +
      "trait try unset use var while xor yield die exit empty eval",
  ),
  types: words("int float bool string void iterable object mixed never self parent"),
  blockKeywords: words("catch do else elseif finally for foreach if switch try while"),
  atoms: words(
    "true false null TRUE FALSE NULL __CLASS__ __DIR__ __FILE__ __LINE__ __FUNCTION__ __METHOD__ __NAMESPACE__",
  ),
  multiLineStrings: true,
  hooks: {
    $: (stream: StringStream) => {
      stream.eatWhile(/[\w$]/);
      return "variable-2";
    },
    // `#[Attribute]` is an attribute; any other `#` starts a comment.
    "#": (stream: StringStream) => {
      if (stream.peek() === "[") return "meta";
      stream.skipToEnd();
      return "comment";
    },
    "<": (stream: StringStream) => (stream.match(/^\?(?:php\b|=)?/) ? "meta" : false),
    "?": (stream: StringStream) => (stream.eat(">") ? "meta" : false),
  },
});

export const solidity = clike({
  name: "solidity",
  keywords: words(
    "pragma solidity import contract interface library is function modifier event error struct enum mapping " +
      "constructor fallback receive returns return if else for while do break continue try catch emit revert " +
      "require assert new delete using public private internal external pure view payable virtual override " +
      "constant immutable anonymous indexed memory storage calldata abstract unchecked assembly type as from " +
      "this super",
  ),
  types: words(
    "address bool string bytes byte int int8 int16 int32 int64 int128 int256 uint uint8 uint16 uint32 uint64 " +
      "uint128 uint256 bytes1 bytes4 bytes8 bytes16 bytes20 bytes32 fixed ufixed",
  ),
  blockKeywords: words("contract interface library function modifier struct enum if else for while do try catch"),
  atoms: words("true false wei gwei ether seconds minutes hours days weeks"),
});
