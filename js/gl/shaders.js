/* ============================ SHADERS ============================ */
export const VS_QUAD = `#version 300 es
out vec2 vUV;
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUV = p*2.-1.; gl_Position = vec4(p*2.-1., 0., 1.); }`;

const GLSL_COMMON = `
precision highp float; precision highp int; precision highp sampler3D; precision highp sampler2D;
uniform sampler3D uT0, uT1, uT2, uT3;
uniform vec3 uE[4]; uniform ivec3 uD[4]; uniform float uSp[4];
uniform vec3 uBox;
uniform int uSeqT, uSeqC, uSeqMode, uFAT, uFAC; uniform float uGain; uniform vec2 uWL;
uniform int uSegMode, uSegT, uSegC; uniform vec3 uSegCol[4]; uniform float uSegA;
uniform int uAtT, uAtC;
vec3 tx(int t, vec3 p){
  if(t==0) return texture(uT0, p/uE[0]).rgb;
  if(t==1) return texture(uT1, p/uE[1]).rgb;
  if(t==2) return texture(uT2, p/uE[2]).rgb;
  return texture(uT3, p/uE[3]).rgb;
}
float ch(vec3 v, int c){ return c==0 ? v.r : (c==1 ? v.g : v.b); }
vec3 tf(int t, vec3 p){
  ivec3 i = clamp(ivec3(floor(p/uSp[t])), ivec3(0), uD[t]-1);
  if(t==0) return texelFetch(uT0, i, 0).rgb;
  if(t==1) return texelFetch(uT1, i, 0).rgb;
  if(t==2) return texelFetch(uT2, i, 0).rgb;
  return texelFetch(uT3, i, 0).rgb;
}
int lab(int t, int c, vec3 p){ return int(ch(tf(t,p),c)*255.+.5); }
vec3 seqColor(vec3 p){
  if(uSeqMode==1){ vec3 d = tx(uSeqT,p); float fa = ch(tx(uFAT,p),uFAC); return clamp(d*fa*uGain, 0., 1.); }
  float v = ch(tx(uSeqT,p), uSeqC);
  return vec3(clamp((v - uWL.y + uWL.x*.5)/max(uWL.x, 1e-3), 0., 1.));
}
float seqValue(vec3 p){ if(uSeqMode==1) return ch(tx(uFAT,p),uFAC); return ch(tx(uSeqT,p), uSeqC); }
`;

export const FS_SLICE = `#version 300 es
${GLSL_COMMON}
uniform vec3 uO, uU, uV; uniform vec2 uPx; uniform int uHover;
uniform int uTumT, uTumC; uniform vec3 uTumCol; uniform int uTumOn;
in vec2 vUV; out vec4 o;
void main(){
  vec3 p = uO + uU*vUV.x + uV*vUV.y;
  if(any(lessThan(p, vec3(0.))) || any(greaterThan(p, uBox))){ o = vec4(0.,0.,0.,1.); return; }
  vec3 col = seqColor(p);
  vec3 du = normalize(uU)*uPx.x, dv = normalize(uV)*uPx.y;
  if(uSegMode==1){
    int L = lab(uSegT,uSegC,p);
    if(L>0 && L<4){
      int l1 = lab(uSegT,uSegC,p+du), l2 = lab(uSegT,uSegC,p-du), l3 = lab(uSegT,uSegC,p+dv), l4 = lab(uSegT,uSegC,p-dv);
      col = mix(col, uSegCol[L], uSegA);
      if(l1!=L || l2!=L || l3!=L || l4!=L) col = mix(col, uSegCol[L], .9);
    }
  }
  if(uTumOn==1){
    float f = ch(tx(uTumT,p), uTumC);
    float w = max(fwidth(f), 1e-4);
    col = mix(col, uTumCol, uSegA*.7*smoothstep(.45,.55,f));
    col = mix(col, uTumCol, .95*(1.-smoothstep(0., 1.1, abs(f-.5)/w)));
  }
  if(uHover>0){
    int a = lab(uAtT,uAtC,p);
    if(a==uHover){
      col = mix(col, vec3(.55,.82,1.), .14);
      int a1 = lab(uAtT,uAtC,p+du), a2 = lab(uAtT,uAtC,p-du), a3 = lab(uAtT,uAtC,p+dv), a4 = lab(uAtT,uAtC,p-dv);
      if(a1!=a || a2!=a || a3!=a || a4!=a) col = mix(col, vec3(.6,.87,1.), .75);
    }
  }
  o = vec4(col, 1.);
}`;

export function fs3D(C) {
  const head = !!C.meta.has_head;
  const fieldsBody = head
    ? `vec3 a = texture(uT0, p/uE[0]).rgb; vec3 b = texture(uT1, p/uE[1]).rgb;
       f[0]=a.b; f[1]=a.g; f[2]=b.g; f[3]=b.r; f[4]=0.; f[5]=0.;`
    : `vec3 b = texture(uT1, p/uE[1]).rgb; vec3 d = texture(uT3, p/uE[3]).rgb;
       f[0]=0.; f[1]=b.g; f[2]=b.b; f[3]=d.r; f[4]=clamp(d.g-d.r,0.,1.); f[5]=d.b;`;
  const capMask = head ? `return texture(uT0, p/uE[0]).b;` : `return texture(uT2, p/uE[2]).b;`;
  const SURF = head ? 0 : 1;
  return `#version 300 es
${GLSL_COMMON}
uniform mat4 uInvVP, uVP; uniform vec3 uEye, uLight;
uniform vec3 uCross, uCutDir; uniform int uCut;
uniform float uStep; uniform float uOp[6]; uniform vec3 uCol[6]; uniform int uCaps, uClipTum;
uniform int uEloq;
uniform int uRisk; uniform sampler2D uRiskTex; uniform vec3 uTarget;
uniform int uFoot; uniform sampler2D uFootTex; uniform vec3 uFootO, uFootU, uFootV, uFootN; uniform float uFootR;
uniform int uMip; uniform vec3 uBgA, uBgB;
in vec2 vUV; out vec4 o;
void fields(vec3 p, out float f[6]){ ${fieldsBody} }
float fieldL(int L, vec3 p){ float f[6]; fields(p, f); return f[L]; }
bool inCut(vec3 p){ if(uCut==0) return false; vec3 d = (p-uCross)*uCutDir; return d.x>0. && d.y>0. && d.z>0.; }
bool outside(vec3 p){ return any(lessThan(p, vec3(0.))) || any(greaterThan(p, uBox)); }
float capMask(vec3 p){ ${capMask} }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
float depthOf(vec3 p){ vec4 c = uVP*vec4(p,1.); return clamp(c.z/c.w*.5+.5, 0., 1.); }
vec4 riskAt(vec3 p){ vec3 d = normalize(p-uTarget); float u = atan(d.y,d.x)/6.2831853+.5; float v = asin(clamp(d.z,-1.,1.))/3.14159265+.5; return texture(uRiskTex, vec2(u,v)); }
vec3 footAt(vec3 p, vec3 base){
  vec3 q = p-uFootO; if(dot(q,uFootN) < 0.) return base;
  vec2 uv = vec2(dot(q,uFootU), dot(q,uFootV))/uFootR*.5+.5;
  if(any(lessThan(uv,vec2(0.))) || any(greaterThan(uv,vec2(1.)))) return base;
  vec2 m = texture(uFootTex, uv).rg;
  base = mix(base, vec3(1.,.72,.26), m.r*.5);
  return mix(base, vec3(1.,.93,.7), m.g*.95);
}
vec3 capColor(vec3 p){
  vec3 c = seqColor(p);
  if(uSegMode==1){ int L = lab(uSegT,uSegC,p); if(L>0 && L<4) c = mix(c, uSegCol[L], uSegA); }
  else if(uSegMode==2){ float f = ch(tx(uSegT,p),uSegC); c = mix(c, uSegCol[1], uSegA*.7*smoothstep(.4,.6,f)); }
  vec3 d = abs(p-uCross); float e = .55;
  int face = (d.x<d.y && d.x<d.z) ? 0 : ((d.y<d.z) ? 1 : 2);
  int n = int(d.x<e) + int(d.y<e) + int(d.z<e);
  if(n>=2){ vec3 fc = face==0 ? vec3(.89,.77,.26) : (face==1 ? vec3(.36,.73,.44) : vec3(.88,.32,.35)); c = mix(c, fc, .9); }
  return c;
}
vec3 shade(int L, vec3 p, vec3 n, vec3 rd){
  vec3 base = uCol[L];
  if(L==1 && uEloq==1){
    int a = lab(uAtT,uAtC,p-n*1.6) & 127;
    if(a==7) base = mix(base, vec3(.72,.45,.98), .62);
    else if(a==17) base = mix(base, vec3(.36,.70,.98), .45);
    else if(a==26) base = mix(base, vec3(.96,.52,.80), .45);
  }
  if(L==${SURF}){
    if(uRisk==1){ vec4 r = riskAt(p); base = mix(base, r.rgb, r.a*.62); }
    if(uFoot==1) base = footAt(p, base);
  }
  float ao = 1.;
  if(L<=1){ float a1 = fieldL(L, p+n*1.3), a2 = fieldL(L, p+n*3.0); ao = 1. - .6*clamp(a1*.55 + a2*.55, 0., 1.); }
  float dif = max(dot(n, uLight), 0.);
  float fill = max(dot(n, -rd), 0.);
  vec3 h = normalize(uLight - rd);
  float sp = pow(max(dot(n,h),0.), L<=1 ? 24. : 50.) * (L<=1 ? .10 : .32);
  float rim = pow(1.-fill, 3.) * .10;
  return base*(.16 + .60*dif + .32*fill)*ao + sp + rim;
}
vec3 gradL(int L, vec3 p){
  float h = .9;
  return vec3(fieldL(L,p+vec3(h,0,0))-fieldL(L,p-vec3(h,0,0)), fieldL(L,p+vec3(0,h,0))-fieldL(L,p-vec3(0,h,0)), fieldL(L,p+vec3(0,0,h))-fieldL(L,p-vec3(0,0,h)));
}
void main(){
  vec4 a = uInvVP*vec4(vUV,-1.,1.), b = uInvVP*vec4(vUV,1.,1.);
  vec3 ro = a.xyz/a.w, rf = b.xyz/b.w, rd = normalize(rf-ro);
  vec3 bg = mix(uBgA, uBgB, clamp(length(vUV*vec2(.8,1.))*.75, 0., 1.));
  vec3 iv = 1./rd; vec3 t0s = (vec3(0.)-ro)*iv, t1s = (uBox-ro)*iv;
  vec3 tmn = min(t0s,t1s), tmx = max(t0s,t1s);
  float tn = max(max(tmn.x,tmn.y), max(tmn.z,0.)), tf = min(min(tmx.x,tmx.y), tmx.z);
  gl_FragDepth = 1.;
  if(tf <= tn){ o = vec4(bg,1.); return; }
  float t = tn + uStep*hash(gl_FragCoord.xy);
  if(uMip==1){
    float m = 0.;
    for(int i=0;i<2000;i++){
      t += uStep*1.4; if(t>tf) break;
      vec3 p = ro+rd*t;
      if(capMask(p) > .5) m = max(m, seqValue(p));
    }
    float g = clamp((m - uWL.y + uWL.x*.5)/max(uWL.x,1e-3), 0., 1.);
    o = vec4(mix(bg, vec3(g), clamp(m*6.,0.,1.)), 1.); return;
  }
  float prev[6]; float cur[6];
  vec3 p = ro+rd*t; fields(p, prev);
  bool prevCut = true;   // outside the volume behaves like a cut
  vec4 acc = vec4(0.); float depth = 1.;
  bool skinDone = false, ctxDone = false;
  for(int i=0;i<2400;i++){
    t += uStep; if(t > tf) break;
    p = ro+rd*t;
    fields(p, cur);
    bool cut = inCut(p);
    if(prevCut && !cut && uCaps==1){
      float lo = t-uStep, hi = t;
      if(i>0){ for(int k=0;k<6;k++){ float m = (lo+hi)*.5; if(inCut(ro+rd*m)) lo = m; else hi = m; } }
      vec3 pc = ro+rd*hi;
      if(capMask(pc) > .5){
        vec3 c = capColor(pc);
        acc.rgb += (1.-acc.a)*c; acc.a = 1.; if(depth==1.) depth = depthOf(pc);
        break;
      }
    }
    for(int L=0;L<6;L++){
      if(uOp[L] <= 0.) continue;
      if(L==0 && skinDone) continue;
      if(L==1 && ctxDone) continue;
      bool clipped = cut && (L<=1 || uClipTum==1);
      if(prev[L] < .5 && cur[L] >= .5 && !clipped){
        float fr = (.5-prev[L])/max(cur[L]-prev[L], 1e-4);
        vec3 ph = ro + rd*(t-uStep+uStep*fr);
        vec3 g = gradL(L, ph);
        vec3 n = -normalize(g + vec3(1e-6));
        vec3 c = shade(L, ph, n, rd);
        float al = uOp[L];
        acc.rgb += (1.-acc.a)*al*c; acc.a += (1.-acc.a)*al;
        if(depth==1. && al>.5) depth = depthOf(ph);
        if(L==0) skinDone = true; if(L==1) ctxDone = true;
      }
    }
    if(acc.a > .97) break;
    for(int L=0;L<6;L++) prev[L] = cur[L];
    prevCut = cut;
  }
  o = vec4(acc.rgb + (1.-acc.a)*bg, 1.);
  gl_FragDepth = depth;
}`;
}

export const FS_COMP = `#version 300 es
precision highp float; uniform sampler2D uC, uZ; in vec2 vUV; out vec4 o;
void main(){ vec2 uv = vUV*.5+.5; o = texture(uC, uv); gl_FragDepth = texture(uZ, uv).r; }`;

export const VS_TRACT = `#version 300 es
uniform mat4 uVP; uniform vec3 uEye; uniform float uR;
in vec3 aPos; in vec3 aTan; in float aSide; in vec3 aCol; in float aB;
out vec3 vCol; out float vS; out vec3 vSide; out vec3 vView; flat out int vB; out vec3 vP;
void main(){ vP = aPos;
  vec3 view = normalize(aPos-uEye);
  vec3 sd = cross(aTan, view); float l = length(sd); sd = l>1e-5 ? sd/l : vec3(1.,0.,0.);
  gl_Position = uVP*vec4(aPos + sd*aSide*uR, 1.);
  vCol = aCol; vS = aSide; vSide = sd; vView = view; vB = int(aB+.5);
}`;
export const FS_TRACT = `#version 300 es
precision highp float; precision highp sampler3D; uniform int uMask; uniform vec3 uLight; uniform int uOverride; uniform vec3 uOCol;
uniform sampler3D uBrainT; uniform vec3 uBrainE; uniform int uClip;
in vec3 vCol; in float vS; in vec3 vSide; in vec3 vView; flat in int vB; in vec3 vP; out vec4 o;
void main(){
  if(uOverride==0 && ((uMask>>vB)&1)==0) discard;
  if(uClip==1 && texture(uBrainT, vP/uBrainE).g < 0.1) discard;
  float s = clamp(vS,-1.,1.);
  vec3 n = normalize(vSide*s - vView*sqrt(max(1.-s*s, 0.)));
  vec3 c = uOverride==1 ? uOCol : vCol;
  float dif = max(dot(n,uLight),0.), fill = max(dot(n,-vView),0.);
  vec3 h = normalize(uLight - vView); float sp = pow(max(dot(n,h),0.), 30.)*.35;
  o = vec4(c*(.22+.55*dif+.35*fill) + sp, 1.);
}`;
export const VS_SPH = `#version 300 es
uniform mat4 uVP; uniform vec3 uC; uniform float uR; uniform vec3 uCamR, uCamU;
out vec2 q;
void main(){
  vec2 c[6] = vec2[](vec2(-1.,-1.),vec2(1.,-1.),vec2(1.,1.),vec2(-1.,-1.),vec2(1.,1.),vec2(-1.,1.));
  q = c[gl_VertexID]; vec3 p = uC + (uCamR*q.x + uCamU*q.y)*uR;
  gl_Position = uVP*vec4(p,1.);
}`;
export const FS_SPH = `#version 300 es
precision highp float; uniform mat4 uVP; uniform vec3 uC; uniform float uR; uniform vec3 uCamR, uCamU, uCamF, uLight, uColr; uniform int uRing;
in vec2 q; out vec4 o;
void main(){
  float r2 = dot(q,q); if(r2 > 1.) discard;
  if(uRing==1 && r2 < .45) discard;
  float z = sqrt(1.-r2); vec3 n = normalize(uCamR*q.x + uCamU*q.y - uCamF*z);
  vec3 p = uC + n*uR; vec4 cl = uVP*vec4(p,1.); gl_FragDepth = clamp(cl.z/cl.w*.5+.5, 0., 1.);
  float dif = max(dot(n,uLight),0.); vec3 h = normalize(uLight+ -uCamF*-1.);
  o = vec4(uColr*(.3+.7*dif) + pow(max(dot(n, normalize(uLight - uCamF)),0.),40.)*.4, 1.);
}`;
export const VS_LINE = `#version 300 es
uniform mat4 uVP; in vec3 aPos; in vec3 aCol; out vec3 vC; void main(){ vC = aCol; gl_Position = uVP*vec4(aPos,1.); }`;
export const FS_LINE = `#version 300 es
precision highp float; in vec3 vC; out vec4 o; void main(){ o = vec4(vC, 1.); }`;
