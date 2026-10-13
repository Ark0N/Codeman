var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// node_modules/@mediapipe/tasks-vision/vision_bundle.mjs
var t = "undefined" != typeof self ? self : {};
function e() {
  throw Error("Invalid UTF8");
}
function n(t2, e2) {
  return e2 = String.fromCharCode.apply(null, e2), null == t2 ? e2 : t2 + e2;
}
var r;
var i;
var s = "undefined" != typeof TextDecoder;
var o;
var a = "undefined" != typeof TextEncoder;
function c(t2) {
  if (a) t2 = (o || (o = new TextEncoder())).encode(t2);
  else {
    let n2 = 0;
    const r2 = new Uint8Array(3 * t2.length);
    for (let i2 = 0; i2 < t2.length; i2++) {
      var e2 = t2.charCodeAt(i2);
      if (e2 < 128) r2[n2++] = e2;
      else {
        if (e2 < 2048) r2[n2++] = e2 >> 6 | 192;
        else {
          if (e2 >= 55296 && e2 <= 57343) {
            if (e2 <= 56319 && i2 < t2.length) {
              const s2 = t2.charCodeAt(++i2);
              if (s2 >= 56320 && s2 <= 57343) {
                e2 = 1024 * (e2 - 55296) + s2 - 56320 + 65536, r2[n2++] = e2 >> 18 | 240, r2[n2++] = e2 >> 12 & 63 | 128, r2[n2++] = e2 >> 6 & 63 | 128, r2[n2++] = 63 & e2 | 128;
                continue;
              }
              i2--;
            }
            e2 = 65533;
          }
          r2[n2++] = e2 >> 12 | 224, r2[n2++] = e2 >> 6 & 63 | 128;
        }
        r2[n2++] = 63 & e2 | 128;
      }
    }
    t2 = n2 === r2.length ? r2 : r2.subarray(0, n2);
  }
  return t2;
}
var h;
var u;
t: {
  for (l = ["CLOSURE_FLAGS"], d = t, f = 0; f < l.length; f++) if (null == (d = d[l[f]])) {
    u = null;
    break t;
  }
  u = d;
}
var l;
var d;
var f;
var p;
var g = u && u[610401301];
h = null != g && g;
var m = t.navigator;
function y(t2) {
  return !!h && (!!p && p.brands.some((({ brand: e2 }) => e2 && -1 != e2.indexOf(t2))));
}
function _(e2) {
  var n2;
  return (n2 = t.navigator) && (n2 = n2.userAgent) || (n2 = ""), -1 != n2.indexOf(e2);
}
function v() {
  return !!h && (!!p && p.brands.length > 0);
}
function E() {
  return v() ? y("Chromium") : (_("Chrome") || _("CriOS")) && !(!v() && _("Edge")) || _("Silk");
}
function w(t2) {
  return w[" "](t2), t2;
}
p = m && m.userAgentData || null, w[" "] = function() {
};
var T = !v() && (_("Trident") || _("MSIE"));
!_("Android") || E(), E(), _("Safari") && (E() || !v() && _("Coast") || !v() && _("Opera") || !v() && _("Edge") || (v() ? y("Microsoft Edge") : _("Edg/")) || v() && y("Opera"));
var A = {};
var b = null;
function k(t2) {
  const e2 = t2.length;
  let n2 = 3 * e2 / 4;
  n2 % 3 ? n2 = Math.floor(n2) : -1 != "=.".indexOf(t2[e2 - 1]) && (n2 = -1 != "=.".indexOf(t2[e2 - 2]) ? n2 - 2 : n2 - 1);
  const r2 = new Uint8Array(n2);
  let i2 = 0;
  return (function(t3, e3) {
    function n3(e4) {
      for (; r3 < t3.length; ) {
        const e5 = t3.charAt(r3++), n4 = b[e5];
        if (null != n4) return n4;
        if (!/^[\s\xa0]*$/.test(e5)) throw Error("Unknown base64 encoding at char: " + e5);
      }
      return e4;
    }
    S();
    let r3 = 0;
    for (; ; ) {
      const t4 = n3(-1), r4 = n3(0), i3 = n3(64), s2 = n3(64);
      if (64 === s2 && -1 === t4) break;
      e3(t4 << 2 | r4 >> 4), 64 != i3 && (e3(r4 << 4 & 240 | i3 >> 2), 64 != s2 && e3(i3 << 6 & 192 | s2));
    }
  })(t2, (function(t3) {
    r2[i2++] = t3;
  })), i2 !== n2 ? r2.subarray(0, i2) : r2;
}
function S() {
  if (!b) {
    b = {};
    var t2 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(""), e2 = ["+/=", "+/", "-_=", "-_.", "-_"];
    for (let n2 = 0; n2 < 5; n2++) {
      const r2 = t2.concat(e2[n2].split(""));
      A[n2] = r2;
      for (let t3 = 0; t3 < r2.length; t3++) {
        const e3 = r2[t3];
        void 0 === b[e3] && (b[e3] = t3);
      }
    }
  }
}
var x = "undefined" != typeof Uint8Array;
var L = !T && "function" == typeof btoa;
function R(t2) {
  if (!L) {
    var e2;
    void 0 === e2 && (e2 = 0), S(), e2 = A[e2];
    var n2 = Array(Math.floor(t2.length / 3)), r2 = e2[64] || "";
    let c2 = 0, h2 = 0;
    for (; c2 < t2.length - 2; c2 += 3) {
      var i2 = t2[c2], s2 = t2[c2 + 1], o2 = t2[c2 + 2], a2 = e2[i2 >> 2];
      i2 = e2[(3 & i2) << 4 | s2 >> 4], s2 = e2[(15 & s2) << 2 | o2 >> 6], o2 = e2[63 & o2], n2[h2++] = a2 + i2 + s2 + o2;
    }
    switch (a2 = 0, o2 = r2, t2.length - c2) {
      case 2:
        o2 = e2[(15 & (a2 = t2[c2 + 1])) << 2] || r2;
      case 1:
        t2 = t2[c2], n2[h2] = e2[t2 >> 2] + e2[(3 & t2) << 4 | a2 >> 4] + o2 + r2;
    }
    return n2.join("");
  }
  for (e2 = "", n2 = 0, r2 = t2.length - 10240; n2 < r2; ) e2 += String.fromCharCode.apply(null, t2.subarray(n2, n2 += 10240));
  return e2 += String.fromCharCode.apply(null, n2 ? t2.subarray(n2) : t2), btoa(e2);
}
var F = /[-_.]/g;
var I = { "-": "+", _: "/", ".": "=" };
function M(t2) {
  return I[t2] || "";
}
function P(t2) {
  if (!L) return k(t2);
  F.test(t2) && (t2 = t2.replace(F, M)), t2 = atob(t2);
  const e2 = new Uint8Array(t2.length);
  for (let n2 = 0; n2 < t2.length; n2++) e2[n2] = t2.charCodeAt(n2);
  return e2;
}
function O(t2) {
  return x && null != t2 && t2 instanceof Uint8Array;
}
var C = {};
function U() {
  return B || (B = new N(null, C));
}
function D(t2) {
  j(C);
  var e2 = t2.g;
  return null == (e2 = null == e2 || O(e2) ? e2 : "string" == typeof e2 ? P(e2) : null) ? e2 : t2.g = e2;
}
var N = class {
  h() {
    return new Uint8Array(D(this) || 0);
  }
  constructor(t2, e2) {
    if (j(e2), this.g = t2, null != t2 && 0 === t2.length) throw Error("ByteString should be constructed with non-empty values");
  }
};
var B;
var G;
function j(t2) {
  if (t2 !== C) throw Error("illegal external caller");
}
function V(t2, e2) {
  t2.__closure__error__context__984382 || (t2.__closure__error__context__984382 = {}), t2.__closure__error__context__984382.severity = e2;
}
function X(t2) {
  return V(t2 = Error(t2), "warning"), t2;
}
var H = "function" == typeof Symbol && "symbol" == typeof /* @__PURE__ */ Symbol();
var W = /* @__PURE__ */ new Set();
function z(t2, e2, n2 = false, r2 = false) {
  return t2 = "function" == typeof Symbol && "symbol" == typeof /* @__PURE__ */ Symbol() ? r2 && Symbol.for && t2 ? Symbol.for(t2) : null != t2 ? Symbol(t2) : /* @__PURE__ */ Symbol() : e2, n2 && W.add(t2), t2;
}
var K = z("jas", void 0, true, true);
var Y = z(void 0, "0di");
var $ = z(void 0, "2ex");
var q = z(void 0, "1oa", true);
var J = z(void 0, /* @__PURE__ */ Symbol(), true);
var Z = H ? K : "Ga";
var Q = { Ga: { value: 0, configurable: true, writable: true, enumerable: false } };
var tt = Object.defineProperties;
function et(t2, e2) {
  H || Z in t2 || tt(t2, Q), t2[Z] |= e2;
}
function nt(t2, e2) {
  H || Z in t2 || tt(t2, Q), t2[Z] = e2;
}
function rt(t2) {
  return et(t2, 34), t2;
}
function it(t2, e2) {
  nt(e2, -30975 & (0 | t2));
}
function st(t2, e2) {
  nt(e2, -30941 & (34 | t2));
}
function ot() {
  return "function" == typeof BigInt;
}
function at(t2) {
  return Array.prototype.slice.call(t2);
}
var ct;
var ht = {};
var ut = {};
function lt(t2) {
  return !(!t2 || "object" != typeof t2 || t2.Ia !== ut);
}
function dt(t2) {
  return null !== t2 && "object" == typeof t2 && !Array.isArray(t2) && t2.constructor === Object;
}
function ft(t2, e2) {
  if (null != t2) {
    if ("string" == typeof t2) t2 = t2 ? new N(t2, C) : U();
    else if (t2.constructor !== N) if (O(t2)) t2 = t2.length ? new N(new Uint8Array(t2), C) : U();
    else {
      if (!e2) throw Error();
      t2 = void 0;
    }
  }
  return t2;
}
function pt(t2) {
  return !(!Array.isArray(t2) || t2.length) && !!(1 & (0 | t2[Z]));
}
var gt = [];
function mt(t2) {
  if (2 & t2) throw Error();
}
nt(gt, 55), ct = Object.freeze(gt);
var yt = class _yt {
  constructor(t2, e2, n2) {
    this.l = 0, this.g = t2, this.h = e2, this.m = n2;
  }
  next() {
    if (this.l < this.g.length) {
      const t2 = this.g[this.l++];
      return { done: false, value: this.h ? this.h.call(this.m, t2) : t2 };
    }
    return { done: true, value: void 0 };
  }
  [Symbol.iterator]() {
    return new _yt(this.g, this.h, this.m);
  }
};
function _t(t2) {
  return J ? t2[J] : void 0;
}
var vt = Object.freeze({});
function Et(t2) {
  return t2.Qa = true, t2;
}
var wt = Et(((t2) => "number" == typeof t2));
var Tt = Et(((t2) => "string" == typeof t2));
var At = Et(((t2) => "boolean" == typeof t2));
var bt = "function" == typeof t.BigInt && "bigint" == typeof t.BigInt(0);
var kt = Et(((t2) => bt ? t2 >= xt && t2 <= Rt : "-" === t2[0] ? Ft(t2, St) : Ft(t2, Lt)));
var St = Number.MIN_SAFE_INTEGER.toString();
var xt = bt ? BigInt(Number.MIN_SAFE_INTEGER) : void 0;
var Lt = Number.MAX_SAFE_INTEGER.toString();
var Rt = bt ? BigInt(Number.MAX_SAFE_INTEGER) : void 0;
function Ft(t2, e2) {
  if (t2.length > e2.length) return false;
  if (t2.length < e2.length || t2 === e2) return true;
  for (let n2 = 0; n2 < t2.length; n2++) {
    const r2 = t2[n2], i2 = e2[n2];
    if (r2 > i2) return false;
    if (r2 < i2) return true;
  }
}
var It = "function" == typeof Uint8Array.prototype.slice;
var Mt;
var Pt = 0;
var Ot = 0;
function Ct(t2) {
  const e2 = t2 >>> 0;
  Pt = e2, Ot = (t2 - e2) / 4294967296 >>> 0;
}
function Ut(t2) {
  if (t2 < 0) {
    Ct(-t2);
    const [e2, n2] = Xt(Pt, Ot);
    Pt = e2 >>> 0, Ot = n2 >>> 0;
  } else Ct(t2);
}
function Dt(t2) {
  const e2 = Mt || (Mt = new DataView(new ArrayBuffer(8)));
  e2.setFloat32(0, +t2, true), Ot = 0, Pt = e2.getUint32(0, true);
}
function Nt(t2, e2) {
  const n2 = 4294967296 * e2 + (t2 >>> 0);
  return Number.isSafeInteger(n2) ? n2 : Gt(t2, e2);
}
function Bt(t2, e2) {
  const n2 = 2147483648 & e2;
  return n2 && (e2 = ~e2 >>> 0, 0 == (t2 = 1 + ~t2 >>> 0) && (e2 = e2 + 1 >>> 0)), "number" == typeof (t2 = Nt(t2, e2)) ? n2 ? -t2 : t2 : n2 ? "-" + t2 : t2;
}
function Gt(t2, e2) {
  if (t2 >>>= 0, (e2 >>>= 0) <= 2097151) var n2 = "" + (4294967296 * e2 + t2);
  else ot() ? n2 = "" + (BigInt(e2) << BigInt(32) | BigInt(t2)) : (t2 = (16777215 & t2) + 6777216 * (n2 = 16777215 & (t2 >>> 24 | e2 << 8)) + 6710656 * (e2 = e2 >> 16 & 65535), n2 += 8147497 * e2, e2 *= 2, t2 >= 1e7 && (n2 += t2 / 1e7 >>> 0, t2 %= 1e7), n2 >= 1e7 && (e2 += n2 / 1e7 >>> 0, n2 %= 1e7), n2 = e2 + jt(n2) + jt(t2));
  return n2;
}
function jt(t2) {
  return t2 = String(t2), "0000000".slice(t2.length) + t2;
}
function Vt(t2) {
  if (t2.length < 16) Ut(Number(t2));
  else if (ot()) t2 = BigInt(t2), Pt = Number(t2 & BigInt(4294967295)) >>> 0, Ot = Number(t2 >> BigInt(32) & BigInt(4294967295));
  else {
    const e2 = +("-" === t2[0]);
    Ot = Pt = 0;
    const n2 = t2.length;
    for (let r2 = e2, i2 = (n2 - e2) % 6 + e2; i2 <= n2; r2 = i2, i2 += 6) {
      const e3 = Number(t2.slice(r2, i2));
      Ot *= 1e6, Pt = 1e6 * Pt + e3, Pt >= 4294967296 && (Ot += Math.trunc(Pt / 4294967296), Ot >>>= 0, Pt >>>= 0);
    }
    if (e2) {
      const [t3, e3] = Xt(Pt, Ot);
      Pt = t3, Ot = e3;
    }
  }
}
function Xt(t2, e2) {
  return e2 = ~e2, t2 ? t2 = 1 + ~t2 : e2 += 1, [t2, e2];
}
var Ht = "function" == typeof BigInt ? BigInt.asIntN : void 0;
var Wt = "function" == typeof BigInt ? BigInt.asUintN : void 0;
var zt = Number.isSafeInteger;
var Kt = Number.isFinite;
var Yt = Math.trunc;
function $t(t2) {
  return null == t2 || "number" == typeof t2 ? t2 : "NaN" === t2 || "Infinity" === t2 || "-Infinity" === t2 ? Number(t2) : void 0;
}
function qt(t2) {
  return null == t2 || "boolean" == typeof t2 ? t2 : "number" == typeof t2 ? !!t2 : void 0;
}
var Jt = /^-?([1-9][0-9]*|0)(\.[0-9]+)?$/;
function Zt(t2) {
  switch (typeof t2) {
    case "bigint":
      return true;
    case "number":
      return Kt(t2);
    case "string":
      return Jt.test(t2);
    default:
      return false;
  }
}
function Qt(t2) {
  if (null == t2) return t2;
  if ("string" == typeof t2 && t2) t2 = +t2;
  else if ("number" != typeof t2) return;
  return Kt(t2) ? 0 | t2 : void 0;
}
function te(t2) {
  if (null == t2) return t2;
  if ("string" == typeof t2 && t2) t2 = +t2;
  else if ("number" != typeof t2) return;
  return Kt(t2) ? t2 >>> 0 : void 0;
}
function ee(t2) {
  if ("-" === t2[0]) return false;
  const e2 = t2.length;
  return e2 < 20 || 20 === e2 && Number(t2.substring(0, 6)) < 184467;
}
function ne(t2) {
  return t2 = Yt(t2), zt(t2) || (Ut(t2), t2 = Bt(Pt, Ot)), t2;
}
function re(t2) {
  var e2 = Yt(Number(t2));
  if (zt(e2)) return String(e2);
  if (-1 !== (e2 = t2.indexOf(".")) && (t2 = t2.substring(0, e2)), e2 = t2.length, !("-" === t2[0] ? e2 < 20 || 20 === e2 && Number(t2.substring(0, 7)) > -922337 : e2 < 19 || 19 === e2 && Number(t2.substring(0, 6)) < 922337)) if (Vt(t2), t2 = Pt, 2147483648 & (e2 = Ot)) if (ot()) t2 = "" + (BigInt(0 | e2) << BigInt(32) | BigInt(t2 >>> 0));
  else {
    const [n2, r2] = Xt(t2, e2);
    t2 = "-" + Gt(n2, r2);
  }
  else t2 = Gt(t2, e2);
  return t2;
}
function ie(t2) {
  return null == t2 ? t2 : "bigint" == typeof t2 ? (kt(t2) ? t2 = Number(t2) : (t2 = Ht(64, t2), t2 = kt(t2) ? Number(t2) : String(t2)), t2) : Zt(t2) ? "number" == typeof t2 ? ne(t2) : re(t2) : void 0;
}
function se(t2) {
  if (null == t2) return t2;
  var e2 = typeof t2;
  if ("bigint" === e2) return String(Wt(64, t2));
  if (Zt(t2)) {
    if ("string" === e2) return e2 = Yt(Number(t2)), zt(e2) && e2 >= 0 ? t2 = String(e2) : (-1 !== (e2 = t2.indexOf(".")) && (t2 = t2.substring(0, e2)), ee(t2) || (Vt(t2), t2 = Gt(Pt, Ot))), t2;
    if ("number" === e2) return (t2 = Yt(t2)) >= 0 && zt(t2) ? t2 : (function(t3) {
      if (t3 < 0) {
        Ut(t3);
        var e3 = Gt(Pt, Ot);
        return t3 = Number(e3), zt(t3) ? t3 : e3;
      }
      return ee(e3 = String(t3)) ? e3 : (Ut(t3), Nt(Pt, Ot));
    })(t2);
  }
}
function oe(t2) {
  if ("string" != typeof t2) throw Error();
  return t2;
}
function ae(t2) {
  if (null != t2 && "string" != typeof t2) throw Error();
  return t2;
}
function ce(t2) {
  return null == t2 || "string" == typeof t2 ? t2 : void 0;
}
function he(t2, e2, n2, r2) {
  if (null != t2 && "object" == typeof t2 && t2.W === ht) return t2;
  if (!Array.isArray(t2)) return n2 ? 2 & r2 ? ((t2 = e2[Y]) || (rt((t2 = new e2()).u), t2 = e2[Y] = t2), e2 = t2) : e2 = new e2() : e2 = void 0, e2;
  let i2 = n2 = 0 | t2[Z];
  return 0 === i2 && (i2 |= 32 & r2), i2 |= 2 & r2, i2 !== n2 && nt(t2, i2), new e2(t2);
}
function ue(t2, e2, n2) {
  if (e2) t: {
    if (!Zt(e2 = t2)) throw X("int64");
    switch (typeof e2) {
      case "string":
        e2 = re(e2);
        break t;
      case "bigint":
        if (t2 = e2 = Ht(64, e2), Tt(t2)) {
          if (!/^\s*(?:-?[1-9]\d*|0)?\s*$/.test(t2)) throw Error(String(t2));
        } else if (wt(t2) && !Number.isSafeInteger(t2)) throw Error(String(t2));
        e2 = bt ? BigInt(e2) : At(e2) ? e2 ? "1" : "0" : Tt(e2) ? e2.trim() || "0" : String(e2);
        break t;
      default:
        e2 = ne(e2);
    }
  }
  else e2 = ie(t2);
  return "string" == typeof (n2 = null == (t2 = e2) ? n2 ? 0 : void 0 : t2) && zt(e2 = +n2) ? e2 : n2;
}
var le = {};
var de = (function() {
  try {
    return w(new class extends Map {
      constructor() {
        super();
      }
    }()), false;
  } catch {
    return true;
  }
})();
var fe = class {
  constructor() {
    this.g = /* @__PURE__ */ new Map();
  }
  get(t2) {
    return this.g.get(t2);
  }
  set(t2, e2) {
    return this.g.set(t2, e2), this.size = this.g.size, this;
  }
  delete(t2) {
    return t2 = this.g.delete(t2), this.size = this.g.size, t2;
  }
  clear() {
    this.g.clear(), this.size = this.g.size;
  }
  has(t2) {
    return this.g.has(t2);
  }
  entries() {
    return this.g.entries();
  }
  keys() {
    return this.g.keys();
  }
  values() {
    return this.g.values();
  }
  forEach(t2, e2) {
    return this.g.forEach(t2, e2);
  }
  [Symbol.iterator]() {
    return this.entries();
  }
};
var pe = de ? (Object.setPrototypeOf(fe.prototype, Map.prototype), Object.defineProperties(fe.prototype, { size: { value: 0, configurable: true, enumerable: true, writable: true } }), fe) : class extends Map {
  constructor() {
    super();
  }
};
function ge(t2) {
  return t2;
}
function me(t2) {
  if (2 & t2.L) throw Error("Cannot mutate an immutable Map");
}
var ye = class extends pe {
  constructor(t2, e2, n2 = ge, r2 = ge) {
    super();
    let i2 = 0 | t2[Z];
    i2 |= 64, nt(t2, i2), this.L = i2, this.S = e2, this.R = n2, this.Y = this.S ? _e : r2;
    for (let s2 = 0; s2 < t2.length; s2++) {
      const o2 = t2[s2], a2 = n2(o2[0], false, true);
      let c2 = o2[1];
      e2 ? void 0 === c2 && (c2 = null) : c2 = r2(o2[1], false, true, void 0, void 0, i2), super.set(a2, c2);
    }
  }
  na(t2 = ve) {
    if (0 !== this.size) return this.X(t2);
  }
  X(t2 = ve) {
    const e2 = [], n2 = super.entries();
    for (var r2; !(r2 = n2.next()).done; ) (r2 = r2.value)[0] = t2(r2[0]), r2[1] = t2(r2[1]), e2.push(r2);
    return e2;
  }
  clear() {
    me(this), super.clear();
  }
  delete(t2) {
    return me(this), super.delete(this.R(t2, true, false));
  }
  entries() {
    var t2 = this.ma();
    return new yt(t2, Ee, this);
  }
  keys() {
    return this.Ha();
  }
  values() {
    var t2 = this.ma();
    return new yt(t2, ye.prototype.get, this);
  }
  forEach(t2, e2) {
    super.forEach(((n2, r2) => {
      t2.call(e2, this.get(r2), r2, this);
    }));
  }
  set(t2, e2) {
    return me(this), null == (t2 = this.R(t2, true, false)) ? this : null == e2 ? (super.delete(t2), this) : super.set(t2, this.Y(e2, true, true, this.S, false, this.L));
  }
  Na(t2) {
    const e2 = this.R(t2[0], false, true);
    t2 = t2[1], t2 = this.S ? void 0 === t2 ? null : t2 : this.Y(t2, false, true, void 0, false, this.L), super.set(e2, t2);
  }
  has(t2) {
    return super.has(this.R(t2, false, false));
  }
  get(t2) {
    t2 = this.R(t2, false, false);
    const e2 = super.get(t2);
    if (void 0 !== e2) {
      var n2 = this.S;
      return n2 ? ((n2 = this.Y(e2, false, true, n2, this.ra, this.L)) !== e2 && super.set(t2, n2), n2) : e2;
    }
  }
  ma() {
    return Array.from(super.keys());
  }
  Ha() {
    return super.keys();
  }
  [Symbol.iterator]() {
    return this.entries();
  }
};
function _e(t2, e2, n2, r2, i2, s2) {
  return t2 = he(t2, r2, n2, s2), i2 && (t2 = Oe(t2)), t2;
}
function ve(t2) {
  return t2;
}
function Ee(t2) {
  return [t2, this.get(t2)];
}
var we;
var Te;
var Ae;
function be() {
  return we || (we = new ye(rt([]), void 0, void 0, void 0, le));
}
function ke(t2, e2, n2, r2, i2) {
  if (null != t2) {
    if (Array.isArray(t2)) t2 = pt(t2) ? void 0 : i2 && 2 & (0 | t2[Z]) ? t2 : Se(t2, e2, n2, void 0 !== r2, i2);
    else if (dt(t2)) {
      const s2 = {};
      for (let o2 in t2) s2[o2] = ke(t2[o2], e2, n2, r2, i2);
      t2 = s2;
    } else t2 = e2(t2, r2);
    return t2;
  }
}
function Se(t2, e2, n2, r2, i2) {
  const s2 = r2 || n2 ? 0 | t2[Z] : 0, o2 = r2 ? !!(32 & s2) : void 0;
  r2 = at(t2);
  for (let t3 = 0; t3 < r2.length; t3++) r2[t3] = ke(r2[t3], e2, n2, o2, i2);
  return n2 && ((t2 = _t(t2)) && (r2[J] = at(t2)), n2(s2, r2)), r2;
}
function xe(t2) {
  return ke(t2, Le, void 0, void 0, false);
}
function Le(t2) {
  return t2.W === ht ? t2.toJSON() : t2 instanceof ye ? t2.na(xe) : (function(t3) {
    switch (typeof t3) {
      case "number":
        return isFinite(t3) ? t3 : String(t3);
      case "bigint":
        return kt(t3) ? Number(t3) : String(t3);
      case "boolean":
        return t3 ? 1 : 0;
      case "object":
        if (t3) if (Array.isArray(t3)) {
          if (pt(t3)) return;
        } else {
          if (O(t3)) return R(t3);
          if (t3 instanceof N) {
            const e2 = t3.g;
            return null == e2 ? "" : "string" == typeof e2 ? e2 : t3.g = R(e2);
          }
          if (t3 instanceof ye) return t3.na();
        }
    }
    return t3;
  })(t2);
}
function Re(t2) {
  return Se(t2, Le, void 0, void 0, false);
}
function Fe(t2, e2, n2) {
  return t2 = Ie(t2, e2[0], e2[1], n2 ? 1 : 2), e2 !== Te && n2 && et(t2, 16384), t2;
}
function Ie(t2, e2, n2, r2) {
  if (null == t2) {
    var i2 = 96;
    n2 ? (t2 = [n2], i2 |= 512) : t2 = [], e2 && (i2 = -33521665 & i2 | (1023 & e2) << 15);
  } else {
    if (!Array.isArray(t2)) throw Error("narr");
    if (2048 & (i2 = 0 | t2[Z])) throw Error("farr");
    if (64 & i2) return t2;
    if (1 === r2 || 2 === r2 || (i2 |= 64), n2 && (i2 |= 512, n2 !== t2[0])) throw Error("mid");
    t: {
      if (r2 = (n2 = t2).length) {
        const t3 = r2 - 1;
        if (dt(n2[t3])) {
          if ((e2 = t3 - (512 & (i2 |= 256) ? 0 : -1)) >= 1024) throw Error("pvtlmt");
          i2 = -33521665 & i2 | (1023 & e2) << 15;
          break t;
        }
      }
      if (e2) {
        if ((e2 = Math.max(e2, r2 - (512 & i2 ? 0 : -1))) > 1024) throw Error("spvt");
        i2 = -33521665 & i2 | (1023 & e2) << 15;
      }
    }
  }
  return nt(t2, i2), t2;
}
function Me(t2, e2, n2 = st) {
  if (null != t2) {
    if (x && t2 instanceof Uint8Array) return e2 ? t2 : new Uint8Array(t2);
    if (Array.isArray(t2)) {
      var r2 = 0 | t2[Z];
      return 2 & r2 ? t2 : (e2 && (e2 = 0 === r2 || !!(32 & r2) && !(64 & r2 || !(16 & r2))), e2 ? (nt(t2, -12293 & (34 | r2)), t2) : Se(t2, Me, 4 & r2 ? st : n2, true, true));
    }
    return t2.W === ht ? t2 = 2 & (r2 = 0 | (n2 = t2.u)[Z]) ? t2 : new t2.constructor(Pe(n2, r2, true)) : t2 instanceof ye && !(2 & t2.L) && (n2 = rt(t2.X(Me)), t2 = new ye(n2, t2.S, t2.R, t2.Y)), t2;
  }
}
function Pe(t2, e2, n2) {
  const r2 = n2 || 2 & e2 ? st : it, i2 = !!(32 & e2);
  return t2 = (function(t3, e3, n3) {
    const r3 = at(t3);
    var i3 = r3.length;
    const s2 = 256 & e3 ? r3[i3 - 1] : void 0;
    for (i3 += s2 ? -1 : 0, e3 = 512 & e3 ? 1 : 0; e3 < i3; e3++) r3[e3] = n3(r3[e3]);
    if (s2) {
      e3 = r3[e3] = {};
      for (const t4 in s2) e3[t4] = n3(s2[t4]);
    }
    return (t3 = _t(t3)) && (r3[J] = at(t3)), r3;
  })(t2, e2, ((t3) => Me(t3, i2, r2))), et(t2, 32 | (n2 ? 2 : 0)), t2;
}
function Oe(t2) {
  const e2 = t2.u, n2 = 0 | e2[Z];
  return 2 & n2 ? new t2.constructor(Pe(e2, n2, false)) : t2;
}
function Ce(t2, e2) {
  return Ue(t2 = t2.u, 0 | t2[Z], e2);
}
function Ue(e2, n2, r2, i2) {
  if (-1 === r2) return null;
  var s2 = r2 + (512 & n2 ? 0 : -1);
  const o2 = e2.length - 1;
  return s2 >= o2 && 256 & n2 ? e2[o2][r2] : i2 && 256 & n2 && null != (n2 = e2[o2][r2]) ? (null != e2[s2] && null != $ && ((s2 = (e2 = G ?? (G = {}))[$] || 0) >= 4 || (e2[$] = s2 + 1, V(e2 = Error(), "incident"), (function(e3) {
    t.setTimeout((() => {
      throw e3;
    }), 0);
  })(e2))), n2) : s2 <= o2 ? e2[s2] : void 0;
}
function De(t2, e2, n2) {
  const r2 = t2.u;
  let i2 = 0 | r2[Z];
  return mt(i2), Ne(r2, i2, e2, n2), t2;
}
function Ne(t2, e2, n2, r2) {
  const i2 = 512 & e2 ? 0 : -1, s2 = n2 + i2;
  var o2 = t2.length - 1;
  return s2 >= o2 && 256 & e2 ? (t2[o2][n2] = r2, e2) : s2 <= o2 ? (t2[s2] = r2, 256 & e2 && (n2 in (t2 = t2[o2]) && delete t2[n2]), e2) : (void 0 !== r2 && (n2 >= (o2 = e2 >> 15 & 1023 || 536870912) ? null != r2 && (t2[o2 + i2] = { [n2]: r2 }, nt(t2, e2 |= 256)) : t2[s2] = r2), e2);
}
function Be(t2, e2) {
  let n2 = 0 | (t2 = t2.u)[Z];
  const r2 = Ue(t2, n2, e2), i2 = $t(r2);
  return null != i2 && i2 !== r2 && Ne(t2, n2, e2, i2), i2;
}
function Ge(t2) {
  let e2 = 0 | (t2 = t2.u)[Z];
  const n2 = Ue(t2, e2, 1), r2 = ft(n2, true);
  return null != r2 && r2 !== n2 && Ne(t2, e2, 1, r2), r2;
}
function je() {
  return void 0 === vt ? 2 : 4;
}
function Ve(t2, e2, n2, r2, i2) {
  const s2 = t2.u, o2 = 2 & (t2 = 0 | s2[Z]) ? 1 : r2;
  i2 = !!i2;
  let a2 = 0 | (r2 = Xe(s2, t2, e2))[Z];
  if (!(4 & a2)) {
    4 & a2 && (r2 = at(r2), a2 = an(a2, t2), t2 = Ne(s2, t2, e2, r2));
    let i3 = 0, o3 = 0;
    for (; i3 < r2.length; i3++) {
      const t3 = n2(r2[i3]);
      null != t3 && (r2[o3++] = t3);
    }
    o3 < i3 && (r2.length = o3), a2 = He(a2, t2), n2 = -4097 & (20 | a2), a2 = n2 &= -8193, nt(r2, a2), 2 & a2 && Object.freeze(r2);
  }
  return 1 === o2 || 4 === o2 && 32 & a2 ? We(a2) || (i2 = a2, a2 |= 2, a2 !== i2 && nt(r2, a2), Object.freeze(r2)) : (2 === o2 && We(a2) && (r2 = at(r2), a2 = an(a2, t2), a2 = cn(a2, t2, i2), nt(r2, a2), t2 = Ne(s2, t2, e2, r2)), We(a2) || (e2 = a2, a2 = cn(a2, t2, i2), a2 !== e2 && nt(r2, a2))), r2;
}
function Xe(t2, e2, n2, r2) {
  return t2 = Ue(t2, e2, n2, r2), Array.isArray(t2) ? t2 : ct;
}
function He(t2, e2) {
  return 0 === t2 && (t2 = an(t2, e2)), 1 | t2;
}
function We(t2) {
  return !!(2 & t2) && !!(4 & t2) || !!(2048 & t2);
}
function ze(t2) {
  t2 = at(t2);
  for (let e2 = 0; e2 < t2.length; e2++) {
    const n2 = t2[e2] = at(t2[e2]);
    Array.isArray(n2[1]) && (n2[1] = rt(n2[1]));
  }
  return t2;
}
function Ke(t2, e2, n2, r2) {
  let i2 = 0 | (t2 = t2.u)[Z];
  mt(i2), Ne(t2, i2, e2, ("0" === r2 ? 0 === Number(n2) : n2 === r2) ? void 0 : n2);
}
function Ye(t2, e2, n2, r2, i2) {
  mt(e2);
  var s2 = !(!(64 & e2) && 16384 & e2);
  const o2 = (i2 = Xe(t2, e2, n2, i2)) !== ct;
  if (s2 || !o2) {
    let a2 = s2 = o2 ? 0 | i2[Z] : 0;
    (!o2 || 2 & a2 || We(a2) || 4 & a2 && !(32 & a2)) && (i2 = at(i2), a2 = an(a2, e2), e2 = Ne(t2, e2, n2, i2)), a2 = -13 & He(a2, e2), a2 = cn(r2 ? -17 & a2 : 16 | a2, e2, true), a2 !== s2 && nt(i2, a2);
  }
  return i2;
}
function $e(t2, e2) {
  var n2 = vs;
  return Ze(qe(t2 = t2.u), t2, 0 | t2[Z], n2) === e2 ? e2 : -1;
}
function qe(t2) {
  if (H) return t2[q] ?? (t2[q] = /* @__PURE__ */ new Map());
  if (q in t2) return t2[q];
  const e2 = /* @__PURE__ */ new Map();
  return Object.defineProperty(t2, q, { value: e2 }), e2;
}
function Je(t2, e2, n2, r2) {
  const i2 = qe(t2), s2 = Ze(i2, t2, e2, n2);
  return s2 !== r2 && (s2 && (e2 = Ne(t2, e2, s2)), i2.set(n2, r2)), e2;
}
function Ze(t2, e2, n2, r2) {
  let i2 = t2.get(r2);
  if (null != i2) return i2;
  i2 = 0;
  for (let t3 = 0; t3 < r2.length; t3++) {
    const s2 = r2[t3];
    null != Ue(e2, n2, s2) && (0 !== i2 && (n2 = Ne(e2, n2, i2)), i2 = s2);
  }
  return t2.set(r2, i2), i2;
}
function Qe(t2, e2, n2, r2) {
  let i2, s2 = 0 | t2[Z];
  if (null != (r2 = Ue(t2, s2, n2, r2)) && r2.W === ht) return (e2 = Oe(r2)) !== r2 && Ne(t2, s2, n2, e2), e2.u;
  if (Array.isArray(r2)) {
    const t3 = 0 | r2[Z];
    i2 = 2 & t3 ? Fe(Pe(r2, t3, false), e2, true) : 64 & t3 ? r2 : Fe(i2, e2, true);
  } else i2 = Fe(void 0, e2, true);
  return i2 !== r2 && Ne(t2, s2, n2, i2), i2;
}
function tn(t2, e2, n2, r2) {
  let i2 = 0 | (t2 = t2.u)[Z];
  return (e2 = he(r2 = Ue(t2, i2, n2, r2), e2, false, i2)) !== r2 && null != e2 && Ne(t2, i2, n2, e2), e2;
}
function en(t2, e2, n2, r2 = false) {
  if (null == (e2 = tn(t2, e2, n2, r2))) return e2;
  if (!(2 & (r2 = 0 | (t2 = t2.u)[Z]))) {
    const i2 = Oe(e2);
    i2 !== e2 && Ne(t2, r2, n2, e2 = i2);
  }
  return e2;
}
function nn(t2, e2, n2, r2, i2, s2, o2) {
  t2 = t2.u;
  var a2 = !!(2 & e2);
  const c2 = a2 ? 1 : i2;
  s2 = !!s2, o2 && (o2 = !a2);
  var h2 = 0 | (i2 = Xe(t2, e2, r2))[Z];
  if (!(a2 = !!(4 & h2))) {
    var u2 = i2, l = e2;
    const t3 = !!(2 & (h2 = He(h2, e2)));
    t3 && (l |= 2);
    let r3 = !t3, s3 = true, o3 = 0, a3 = 0;
    for (; o3 < u2.length; o3++) {
      const e3 = he(u2[o3], n2, false, l);
      if (e3 instanceof n2) {
        if (!t3) {
          const t4 = !!(2 & (0 | e3.u[Z]));
          r3 && (r3 = !t4), s3 && (s3 = t4);
        }
        u2[a3++] = e3;
      }
    }
    a3 < o3 && (u2.length = a3), h2 |= 4, h2 = s3 ? 16 | h2 : -17 & h2, nt(u2, h2 = r3 ? 8 | h2 : -9 & h2), t3 && Object.freeze(u2);
  }
  if (o2 && !(8 & h2 || !i2.length && (1 === c2 || 4 === c2 && 32 & h2))) {
    for (We(h2) && (i2 = at(i2), h2 = an(h2, e2), e2 = Ne(t2, e2, r2, i2)), n2 = i2, o2 = h2, u2 = 0; u2 < n2.length; u2++) (h2 = n2[u2]) !== (l = Oe(h2)) && (n2[u2] = l);
    o2 |= 8, nt(n2, o2 = n2.length ? -17 & o2 : 16 | o2), h2 = o2;
  }
  return 1 === c2 || 4 === c2 && 32 & h2 ? We(h2) || (e2 = h2, (h2 |= !i2.length || 16 & h2 && (!a2 || 32 & h2) ? 2 : 2048) !== e2 && nt(i2, h2), Object.freeze(i2)) : (2 === c2 && We(h2) && (nt(i2 = at(i2), h2 = cn(h2 = an(h2, e2), e2, s2)), e2 = Ne(t2, e2, r2, i2)), We(h2) || (r2 = h2, (h2 = cn(h2, e2, s2)) !== r2 && nt(i2, h2))), i2;
}
function rn(t2, e2, n2) {
  const r2 = 0 | t2.u[Z];
  return nn(t2, r2, e2, n2, je(), false, !(2 & r2));
}
function sn(t2, e2, n2, r2) {
  return null == r2 && (r2 = void 0), De(t2, n2, r2);
}
function on(t2, e2, n2, r2) {
  null == r2 && (r2 = void 0);
  t: {
    let i2 = 0 | (t2 = t2.u)[Z];
    if (mt(i2), null == r2) {
      const r3 = qe(t2);
      if (Ze(r3, t2, i2, n2) !== e2) break t;
      r3.set(n2, 0);
    } else i2 = Je(t2, i2, n2, e2);
    Ne(t2, i2, e2, r2);
  }
}
function an(t2, e2) {
  return -2049 & (t2 = 32 | (2 & e2 ? 2 | t2 : -3 & t2));
}
function cn(t2, e2, n2) {
  return 32 & e2 && n2 || (t2 &= -33), t2;
}
function hn(t2, e2, n2, r2) {
  const i2 = 0 | t2.u[Z];
  mt(i2), t2 = nn(t2, i2, n2, e2, 2, true), r2 = null != r2 ? r2 : new n2(), t2.push(r2), t2[Z] = 2 & (0 | r2.u[Z]) ? -9 & t2[Z] : -17 & t2[Z];
}
function un(t2, e2) {
  return Qt(Ce(t2, e2));
}
function ln(t2, e2) {
  return ce(Ce(t2, e2));
}
function dn(t2, e2) {
  return Be(t2, e2) ?? 0;
}
function fn(t2, e2, n2) {
  if (null != n2 && "boolean" != typeof n2) throw t2 = typeof n2, Error(`Expected boolean but got ${"object" != t2 ? t2 : n2 ? Array.isArray(n2) ? "array" : t2 : "null"}: ${n2}`);
  De(t2, e2, n2);
}
function pn(t2, e2, n2) {
  if (null != n2) {
    if ("number" != typeof n2) throw X("int32");
    if (!Kt(n2)) throw X("int32");
    n2 |= 0;
  }
  De(t2, e2, n2);
}
function gn(t2, e2, n2) {
  if (null != n2 && "number" != typeof n2) throw Error(`Value of float/double field must be a number, found ${typeof n2}: ${n2}`);
  De(t2, e2, n2);
}
function mn(t2, e2, n2) {
  {
    const o2 = t2.u;
    let a2 = 0 | o2[Z];
    if (mt(a2), null == n2) Ne(o2, a2, e2);
    else {
      var r2 = t2 = 0 | n2[Z], i2 = We(t2), s2 = i2 || Object.isFrozen(n2);
      for (i2 || (t2 = 0), s2 || (n2 = at(n2), r2 = 0, t2 = cn(t2 = an(t2, a2), a2, true), s2 = false), t2 |= 21, i2 = 0; i2 < n2.length; i2++) {
        const e3 = n2[i2], o3 = oe(e3);
        Object.is(e3, o3) || (s2 && (n2 = at(n2), r2 = 0, t2 = cn(t2 = an(t2, a2), a2, true), s2 = false), n2[i2] = o3);
      }
      t2 !== r2 && (s2 && (n2 = at(n2), t2 = cn(t2 = an(t2, a2), a2, true)), nt(n2, t2)), Ne(o2, a2, e2, n2);
    }
  }
}
function yn(t2, e2, n2) {
  mt(0 | t2.u[Z]), Ve(t2, e2, ce, 2, true).push(oe(n2));
}
function _n(t2, e2) {
  return Error(`Invalid wire type: ${t2} (at position ${e2})`);
}
function vn() {
  return Error("Failed to read varint, encoding is invalid.");
}
function En(t2, e2) {
  return Error(`Tried to read past the end of the data ${e2} > ${t2}`);
}
function wn(t2) {
  if ("string" == typeof t2) return { buffer: P(t2), N: false };
  if (Array.isArray(t2)) return { buffer: new Uint8Array(t2), N: false };
  if (t2.constructor === Uint8Array) return { buffer: t2, N: false };
  if (t2.constructor === ArrayBuffer) return { buffer: new Uint8Array(t2), N: false };
  if (t2.constructor === N) return { buffer: D(t2) || new Uint8Array(0), N: true };
  if (t2 instanceof Uint8Array) return { buffer: new Uint8Array(t2.buffer, t2.byteOffset, t2.byteLength), N: false };
  throw Error("Type not convertible to a Uint8Array, expected a Uint8Array, an ArrayBuffer, a base64 encoded string, a ByteString or an Array of numbers");
}
function Tn(t2, e2) {
  let n2, r2 = 0, i2 = 0, s2 = 0;
  const o2 = t2.h;
  let a2 = t2.g;
  do {
    n2 = o2[a2++], r2 |= (127 & n2) << s2, s2 += 7;
  } while (s2 < 32 && 128 & n2);
  for (s2 > 32 && (i2 |= (127 & n2) >> 4), s2 = 3; s2 < 32 && 128 & n2; s2 += 7) n2 = o2[a2++], i2 |= (127 & n2) << s2;
  if (Fn(t2, a2), n2 < 128) return e2(r2 >>> 0, i2 >>> 0);
  throw vn();
}
function An(t2) {
  let e2 = 0, n2 = t2.g;
  const r2 = n2 + 10, i2 = t2.h;
  for (; n2 < r2; ) {
    const r3 = i2[n2++];
    if (e2 |= r3, 0 == (128 & r3)) return Fn(t2, n2), !!(127 & e2);
  }
  throw vn();
}
function bn(t2) {
  const e2 = t2.h;
  let n2 = t2.g, r2 = e2[n2++], i2 = 127 & r2;
  if (128 & r2 && (r2 = e2[n2++], i2 |= (127 & r2) << 7, 128 & r2 && (r2 = e2[n2++], i2 |= (127 & r2) << 14, 128 & r2 && (r2 = e2[n2++], i2 |= (127 & r2) << 21, 128 & r2 && (r2 = e2[n2++], i2 |= r2 << 28, 128 & r2 && 128 & e2[n2++] && 128 & e2[n2++] && 128 & e2[n2++] && 128 & e2[n2++] && 128 & e2[n2++]))))) throw vn();
  return Fn(t2, n2), i2;
}
function kn(t2) {
  return bn(t2) >>> 0;
}
function Sn(t2) {
  var e2 = t2.h;
  const n2 = t2.g, r2 = e2[n2], i2 = e2[n2 + 1], s2 = e2[n2 + 2];
  return e2 = e2[n2 + 3], Fn(t2, t2.g + 4), (r2 << 0 | i2 << 8 | s2 << 16 | e2 << 24) >>> 0;
}
function xn(t2) {
  var e2 = Sn(t2);
  t2 = 2 * (e2 >> 31) + 1;
  const n2 = e2 >>> 23 & 255;
  return e2 &= 8388607, 255 == n2 ? e2 ? NaN : t2 * (1 / 0) : 0 == n2 ? 1401298464324817e-60 * t2 * e2 : t2 * Math.pow(2, n2 - 150) * (e2 + 8388608);
}
function Ln(t2) {
  return bn(t2);
}
function Rn(t2, e2, { ba: n2 = false } = {}) {
  t2.ba = n2, e2 && (e2 = wn(e2), t2.h = e2.buffer, t2.m = e2.N, t2.j = 0, t2.l = t2.h.length, t2.g = t2.j);
}
function Fn(t2, e2) {
  if (t2.g = e2, e2 > t2.l) throw En(t2.l, e2);
}
function In(t2, e2) {
  if (e2 < 0) throw Error(`Tried to read a negative byte length: ${e2}`);
  const n2 = t2.g, r2 = n2 + e2;
  if (r2 > t2.l) throw En(e2, t2.l - n2);
  return t2.g = r2, n2;
}
function Mn(t2, e2) {
  if (0 == e2) return U();
  var n2 = In(t2, e2);
  return t2.ba && t2.m ? n2 = t2.h.subarray(n2, n2 + e2) : (t2 = t2.h, n2 = n2 === (e2 = n2 + e2) ? new Uint8Array(0) : It ? t2.slice(n2, e2) : new Uint8Array(t2.subarray(n2, e2))), 0 == n2.length ? U() : new N(n2, C);
}
ye.prototype.toJSON = void 0, ye.prototype.Ia = ut;
var Pn = [];
function On(t2) {
  var e2 = t2.g;
  if (e2.g == e2.l) return false;
  t2.l = t2.g.g;
  var n2 = kn(t2.g);
  if (e2 = n2 >>> 3, !((n2 &= 7) >= 0 && n2 <= 5)) throw _n(n2, t2.l);
  if (e2 < 1) throw Error(`Invalid field number: ${e2} (at position ${t2.l})`);
  return t2.m = e2, t2.h = n2, true;
}
function Cn(t2) {
  switch (t2.h) {
    case 0:
      0 != t2.h ? Cn(t2) : An(t2.g);
      break;
    case 1:
      Fn(t2 = t2.g, t2.g + 8);
      break;
    case 2:
      if (2 != t2.h) Cn(t2);
      else {
        var e2 = kn(t2.g);
        Fn(t2 = t2.g, t2.g + e2);
      }
      break;
    case 5:
      Fn(t2 = t2.g, t2.g + 4);
      break;
    case 3:
      for (e2 = t2.m; ; ) {
        if (!On(t2)) throw Error("Unmatched start-group tag: stream EOF");
        if (4 == t2.h) {
          if (t2.m != e2) throw Error("Unmatched end-group tag");
          break;
        }
        Cn(t2);
      }
      break;
    default:
      throw _n(t2.h, t2.l);
  }
}
function Un(t2, e2, n2) {
  const r2 = t2.g.l, i2 = kn(t2.g), s2 = t2.g.g + i2;
  let o2 = s2 - r2;
  if (o2 <= 0 && (t2.g.l = s2, n2(e2, t2, void 0, void 0, void 0), o2 = s2 - t2.g.g), o2) throw Error(`Message parsing ended unexpectedly. Expected to read ${i2} bytes, instead read ${i2 - o2} bytes, either the data ended unexpectedly or the message misreported its own length`);
  return t2.g.g = s2, t2.g.l = r2, e2;
}
function Dn(t2) {
  var o2 = kn(t2.g), a2 = In(t2 = t2.g, o2);
  if (t2 = t2.h, s) {
    var c2, h2 = t2;
    (c2 = i) || (c2 = i = new TextDecoder("utf-8", { fatal: true })), o2 = a2 + o2, h2 = 0 === a2 && o2 === h2.length ? h2 : h2.subarray(a2, o2);
    try {
      var u2 = c2.decode(h2);
    } catch (t3) {
      if (void 0 === r) {
        try {
          c2.decode(new Uint8Array([128]));
        } catch (t4) {
        }
        try {
          c2.decode(new Uint8Array([97])), r = true;
        } catch (t4) {
          r = false;
        }
      }
      throw !r && (i = void 0), t3;
    }
  } else {
    o2 = (u2 = a2) + o2, a2 = [];
    let r2, i2 = null;
    for (; u2 < o2; ) {
      var l = t2[u2++];
      l < 128 ? a2.push(l) : l < 224 ? u2 >= o2 ? e() : (r2 = t2[u2++], l < 194 || 128 != (192 & r2) ? (u2--, e()) : a2.push((31 & l) << 6 | 63 & r2)) : l < 240 ? u2 >= o2 - 1 ? e() : (r2 = t2[u2++], 128 != (192 & r2) || 224 === l && r2 < 160 || 237 === l && r2 >= 160 || 128 != (192 & (c2 = t2[u2++])) ? (u2--, e()) : a2.push((15 & l) << 12 | (63 & r2) << 6 | 63 & c2)) : l <= 244 ? u2 >= o2 - 2 ? e() : (r2 = t2[u2++], 128 != (192 & r2) || r2 - 144 + (l << 28) >> 30 != 0 || 128 != (192 & (c2 = t2[u2++])) || 128 != (192 & (h2 = t2[u2++])) ? (u2--, e()) : (l = (7 & l) << 18 | (63 & r2) << 12 | (63 & c2) << 6 | 63 & h2, l -= 65536, a2.push(55296 + (l >> 10 & 1023), 56320 + (1023 & l)))) : e(), a2.length >= 8192 && (i2 = n(i2, a2), a2.length = 0);
    }
    u2 = n(i2, a2);
  }
  return u2;
}
function Nn(t2) {
  const e2 = kn(t2.g);
  return Mn(t2.g, e2);
}
function Bn(t2, e2, n2) {
  var r2 = kn(t2.g);
  for (r2 = t2.g.g + r2; t2.g.g < r2; ) n2.push(e2(t2.g));
}
var Gn = [];
function jn(t2) {
  return t2;
}
var Vn;
function Xn(t2, e2, n2) {
  e2.g ? e2.m(t2, e2.g, e2.h, n2) : e2.m(t2, e2.h, n2);
}
var Hn = class {
  constructor(t2, e2) {
    this.u = Ie(t2, e2);
  }
  toJSON() {
    const t2 = !Vn;
    try {
      return t2 && (Vn = Re), Wn(this);
    } finally {
      t2 && (Vn = void 0);
    }
  }
  l() {
    var t2 = go;
    return t2.g ? t2.l(this, t2.g, t2.h, true) : t2.l(this, t2.h, t2.defaultValue, true);
  }
  clone() {
    const t2 = this.u;
    return new this.constructor(Pe(t2, 0 | t2[Z], false));
  }
  N() {
    return !!(2 & (0 | this.u[Z]));
  }
};
function Wn(t2) {
  var e2 = t2.u;
  {
    e2 = (t2 = Vn(e2)) !== e2;
    let h2 = t2.length;
    if (h2) {
      var n2 = t2[h2 - 1], r2 = dt(n2);
      r2 ? h2-- : n2 = void 0;
      var i2 = t2;
      if (r2) {
        t: {
          var s2, o2 = n2, a2 = false;
          if (o2) for (let t3 in o2) isNaN(+t3) ? (s2 ?? (s2 = {}))[t3] = o2[t3] : (r2 = o2[t3], Array.isArray(r2) && (pt(r2) || lt(r2) && 0 === r2.size) && (r2 = null), null == r2 && (a2 = true), null != r2 && ((s2 ?? (s2 = {}))[t3] = r2));
          if (a2 || (s2 = o2), s2) for (let t3 in s2) {
            a2 = s2;
            break t;
          }
          a2 = null;
        }
        o2 = null == a2 ? null != n2 : a2 !== n2;
      }
      for (; h2 > 0 && (null == (s2 = i2[h2 - 1]) || pt(s2) || lt(s2) && 0 === s2.size); h2--) var c2 = true;
      (i2 !== t2 || o2 || c2) && (e2 ? (c2 || o2 || a2) && (i2.length = h2) : i2 = Array.prototype.slice.call(i2, 0, h2), a2 && i2.push(a2)), c2 = i2;
    } else c2 = t2;
  }
  return c2;
}
function zn(t2) {
  return t2 ? /^\d+$/.test(t2) ? (Vt(t2), new Kn(Pt, Ot)) : null : Yn || (Yn = new Kn(0, 0));
}
Hn.prototype.W = ht, Hn.prototype.toString = function() {
  try {
    return Vn = jn, Wn(this).toString();
  } finally {
    Vn = void 0;
  }
};
var Kn = class {
  constructor(t2, e2) {
    this.h = t2 >>> 0, this.g = e2 >>> 0;
  }
};
var Yn;
function $n(t2) {
  return t2 ? /^-?\d+$/.test(t2) ? (Vt(t2), new qn(Pt, Ot)) : null : Jn || (Jn = new qn(0, 0));
}
var qn = class {
  constructor(t2, e2) {
    this.h = t2 >>> 0, this.g = e2 >>> 0;
  }
};
var Jn;
function Zn(t2, e2, n2) {
  for (; n2 > 0 || e2 > 127; ) t2.g.push(127 & e2 | 128), e2 = (e2 >>> 7 | n2 << 25) >>> 0, n2 >>>= 7;
  t2.g.push(e2);
}
function Qn(t2, e2) {
  for (; e2 > 127; ) t2.g.push(127 & e2 | 128), e2 >>>= 7;
  t2.g.push(e2);
}
function tr(t2, e2) {
  if (e2 >= 0) Qn(t2, e2);
  else {
    for (let n2 = 0; n2 < 9; n2++) t2.g.push(127 & e2 | 128), e2 >>= 7;
    t2.g.push(1);
  }
}
function er(t2, e2) {
  t2.g.push(e2 >>> 0 & 255), t2.g.push(e2 >>> 8 & 255), t2.g.push(e2 >>> 16 & 255), t2.g.push(e2 >>> 24 & 255);
}
function nr(t2, e2) {
  0 !== e2.length && (t2.l.push(e2), t2.h += e2.length);
}
function rr(t2, e2, n2) {
  Qn(t2.g, 8 * e2 + n2);
}
function ir(t2, e2) {
  return rr(t2, e2, 2), e2 = t2.g.end(), nr(t2, e2), e2.push(t2.h), e2;
}
function sr(t2, e2) {
  var n2 = e2.pop();
  for (n2 = t2.h + t2.g.length() - n2; n2 > 127; ) e2.push(127 & n2 | 128), n2 >>>= 7, t2.h++;
  e2.push(n2), t2.h++;
}
function or(t2, e2, n2) {
  rr(t2, e2, 2), Qn(t2.g, n2.length), nr(t2, t2.g.end()), nr(t2, n2);
}
function ar(t2, e2, n2, r2) {
  null != n2 && (e2 = ir(t2, e2), r2(n2, t2), sr(t2, e2));
}
function cr() {
  const t2 = class {
    constructor() {
      throw Error();
    }
  };
  return Object.setPrototypeOf(t2, t2.prototype), t2;
}
var hr = cr();
var ur = cr();
var lr = cr();
var dr = cr();
var fr = cr();
var pr = cr();
var gr = cr();
var mr = cr();
var yr = cr();
var _r = class {
  constructor(t2, e2, n2) {
    this.g = t2, this.h = e2, t2 = hr, this.l = !!t2 && n2 === t2 || false;
  }
};
function vr(t2, e2) {
  return new _r(t2, e2, hr);
}
function Er(t2, e2, n2, r2, i2) {
  ar(t2, n2, Ir(e2, r2), i2);
}
var wr = vr((function(t2, e2, n2, r2, i2) {
  return 2 === t2.h && (Un(t2, Qe(e2, r2, n2), i2), true);
}), Er);
var Tr = vr((function(t2, e2, n2, r2, i2) {
  return 2 === t2.h && (Un(t2, Qe(e2, r2, n2, true), i2), true);
}), Er);
var Ar = /* @__PURE__ */ Symbol();
var br = /* @__PURE__ */ Symbol();
var kr = /* @__PURE__ */ Symbol();
var Sr = /* @__PURE__ */ Symbol();
var xr;
var Lr;
function Rr(t2, e2, n2, r2) {
  var i2 = r2[t2];
  if (i2) return i2;
  (i2 = {}).Pa = r2, i2.V = (function(t3) {
    switch (typeof t3) {
      case "boolean":
        return Te || (Te = [0, void 0, true]);
      case "number":
        return t3 > 0 ? void 0 : 0 === t3 ? Ae || (Ae = [0, void 0]) : [-t3, void 0];
      case "string":
        return [0, t3];
      case "object":
        return t3;
    }
  })(r2[0]);
  var s2 = r2[1];
  let o2 = 1;
  s2 && s2.constructor === Object && (i2.ga = s2, "function" == typeof (s2 = r2[++o2]) && (i2.la = true, xr ?? (xr = s2), Lr ?? (Lr = r2[o2 + 1]), s2 = r2[o2 += 2]));
  const a2 = {};
  for (; s2 && Array.isArray(s2) && s2.length && "number" == typeof s2[0] && s2[0] > 0; ) {
    for (var c2 = 0; c2 < s2.length; c2++) a2[s2[c2]] = s2;
    s2 = r2[++o2];
  }
  for (c2 = 1; void 0 !== s2; ) {
    let t3;
    "number" == typeof s2 && (c2 += s2, s2 = r2[++o2]);
    var h2 = void 0;
    if (s2 instanceof _r ? t3 = s2 : (t3 = wr, o2--), t3?.l) {
      s2 = r2[++o2], h2 = r2;
      var u2 = o2;
      "function" == typeof s2 && (s2 = s2(), h2[u2] = s2), h2 = s2;
    }
    for (u2 = c2 + 1, "number" == typeof (s2 = r2[++o2]) && s2 < 0 && (u2 -= s2, s2 = r2[++o2]); c2 < u2; c2++) {
      const r3 = a2[c2];
      h2 ? n2(i2, c2, t3, h2, r3) : e2(i2, c2, t3, r3);
    }
  }
  return r2[t2] = i2;
}
function Fr(t2) {
  return Array.isArray(t2) ? t2[0] instanceof _r ? t2 : [Tr, t2] : [t2, void 0];
}
function Ir(t2, e2) {
  return t2 instanceof Hn ? t2.u : Array.isArray(t2) ? Fe(t2, e2, false) : void 0;
}
function Mr(t2, e2, n2, r2) {
  const i2 = n2.g;
  t2[e2] = r2 ? (t3, e3, n3) => i2(t3, e3, n3, r2) : i2;
}
function Pr(t2, e2, n2, r2, i2) {
  const s2 = n2.g;
  let o2, a2;
  t2[e2] = (t3, e3, n3) => s2(t3, e3, n3, a2 || (a2 = Rr(br, Mr, Pr, r2).V), o2 || (o2 = Or(r2)), i2);
}
function Or(t2) {
  let e2 = t2[kr];
  if (null != e2) return e2;
  const n2 = Rr(br, Mr, Pr, t2);
  return e2 = n2.la ? (t3, e3) => xr(t3, e3, n2) : (t3, e3) => {
    const r2 = 0 | t3[Z];
    for (; On(e3) && 4 != e3.h; ) {
      var i2 = e3.m, s2 = n2[i2];
      if (null == s2) {
        var o2 = n2.ga;
        o2 && (o2 = o2[i2]) && (null != (o2 = Cr(o2)) && (s2 = n2[i2] = o2));
      }
      null != s2 && s2(e3, t3, i2) || (i2 = (s2 = e3).l, Cn(s2), s2.fa ? s2 = void 0 : (o2 = s2.g.g - i2, s2.g.g = i2, s2 = Mn(s2.g, o2)), i2 = t3, s2 && ((o2 = i2[J]) ? o2.push(s2) : i2[J] = [s2]));
    }
    return 16384 & r2 && rt(t3), true;
  }, t2[kr] = e2;
}
function Cr(t2) {
  const e2 = (t2 = Fr(t2))[0].g;
  if (t2 = t2[1]) {
    const n2 = Or(t2), r2 = Rr(br, Mr, Pr, t2).V;
    return (t3, i2, s2) => e2(t3, i2, s2, r2, n2);
  }
  return e2;
}
function Ur(t2, e2, n2) {
  t2[e2] = n2.h;
}
function Dr(t2, e2, n2, r2) {
  let i2, s2;
  const o2 = n2.h;
  t2[e2] = (t3, e3, n3) => o2(t3, e3, n3, s2 || (s2 = Rr(Ar, Ur, Dr, r2).V), i2 || (i2 = Nr(r2)));
}
function Nr(t2) {
  let e2 = t2[Sr];
  if (!e2) {
    const n2 = Rr(Ar, Ur, Dr, t2);
    e2 = (t3, e3) => Br(t3, e3, n2), t2[Sr] = e2;
  }
  return e2;
}
function Br(t2, e2, n2) {
  for (var r2 = 0 | t2[Z], i2 = 512 & r2 ? 0 : -1, s2 = t2.length, o2 = 512 & r2 ? 1 : 0, a2 = s2 + (256 & r2 ? -1 : 0); o2 < a2; o2++) {
    const r3 = t2[o2];
    if (null == r3) continue;
    const s3 = o2 - i2, a3 = Gr(n2, s3);
    a3 && a3(e2, r3, s3);
  }
  if (256 & r2) {
    r2 = t2[s2 - 1];
    for (const t3 in r2) i2 = +t3, Number.isNaN(i2) || null != (s2 = r2[i2]) && (a2 = Gr(n2, i2)) && a2(e2, s2, i2);
  }
  if (t2 = _t(t2)) for (nr(e2, e2.g.end()), n2 = 0; n2 < t2.length; n2++) nr(e2, D(t2[n2]) || new Uint8Array(0));
}
function Gr(t2, e2) {
  var n2 = t2[e2];
  if (n2) return n2;
  if ((n2 = t2.ga) && (n2 = n2[e2])) {
    var r2 = (n2 = Fr(n2))[0].h;
    if (n2 = n2[1]) {
      const e3 = Nr(n2), i2 = Rr(Ar, Ur, Dr, n2).V;
      n2 = t2.la ? Lr(i2, e3) : (t3, n3, s2) => r2(t3, n3, s2, i2, e3);
    } else n2 = r2;
    return t2[e2] = n2;
  }
}
function jr(t2, e2) {
  if (Array.isArray(e2)) {
    var n2 = 0 | e2[Z];
    if (4 & n2) return e2;
    for (var r2 = 0, i2 = 0; r2 < e2.length; r2++) {
      const n3 = t2(e2[r2]);
      null != n3 && (e2[i2++] = n3);
    }
    return i2 < r2 && (e2.length = i2), nt(e2, -12289 & (5 | n2)), 2 & n2 && Object.freeze(e2), e2;
  }
}
function Vr(t2, e2, n2) {
  return new _r(t2, e2, n2);
}
function Xr(t2, e2, n2) {
  return new _r(t2, e2, n2);
}
function Hr(t2, e2, n2) {
  Ne(t2, 0 | t2[Z], e2, n2);
}
var Wr = vr((function(t2, e2, n2, r2, i2) {
  return 2 === t2.h && (t2 = Un(t2, Fe([void 0, void 0], r2, true), i2), mt(r2 = 0 | e2[Z]), (i2 = Ue(e2, r2, n2)) instanceof ye ? 0 != (2 & i2.L) ? ((i2 = i2.X()).push(t2), Ne(e2, r2, n2, i2)) : i2.Na(t2) : Array.isArray(i2) ? (2 & (0 | i2[Z]) && Ne(e2, r2, n2, i2 = ze(i2)), i2.push(t2)) : Ne(e2, r2, n2, [t2]), true);
}), (function(t2, e2, n2, r2, i2) {
  if (e2 instanceof ye) e2.forEach(((e3, s2) => {
    ar(t2, n2, Fe([s2, e3], r2, false), i2);
  }));
  else if (Array.isArray(e2)) for (let s2 = 0; s2 < e2.length; s2++) {
    const o2 = e2[s2];
    Array.isArray(o2) && ar(t2, n2, Fe(o2, r2, false), i2);
  }
}));
function zr(t2, e2, n2) {
  if (e2 = (function(t3) {
    if (null == t3) return t3;
    const e3 = typeof t3;
    if ("bigint" === e3) return String(Ht(64, t3));
    if (Zt(t3)) {
      if ("string" === e3) return re(t3);
      if ("number" === e3) return ne(t3);
    }
  })(e2), null != e2) {
    if ("string" == typeof e2) $n(e2);
    if (null != e2) switch (rr(t2, n2, 0), typeof e2) {
      case "number":
        t2 = t2.g, Ut(e2), Zn(t2, Pt, Ot);
        break;
      case "bigint":
        n2 = BigInt.asUintN(64, e2), n2 = new qn(Number(n2 & BigInt(4294967295)), Number(n2 >> BigInt(32))), Zn(t2.g, n2.h, n2.g);
        break;
      default:
        n2 = $n(e2), Zn(t2.g, n2.h, n2.g);
    }
  }
}
function Kr(t2, e2, n2) {
  null != (e2 = Qt(e2)) && null != e2 && (rr(t2, n2, 0), tr(t2.g, e2));
}
function Yr(t2, e2, n2) {
  null != (e2 = qt(e2)) && (rr(t2, n2, 0), t2.g.g.push(e2 ? 1 : 0));
}
function $r(t2, e2, n2) {
  null != (e2 = ce(e2)) && or(t2, n2, c(e2));
}
function qr(t2, e2, n2, r2, i2) {
  ar(t2, n2, Ir(e2, r2), i2);
}
function Jr(t2, e2, n2) {
  null != (e2 = null == e2 || "string" == typeof e2 || O(e2) || e2 instanceof N ? e2 : void 0) && or(t2, n2, wn(e2).buffer);
}
function Zr(t2, e2, n2) {
  return (5 === t2.h || 2 === t2.h) && (e2 = Ye(e2, 0 | e2[Z], n2, false, false), 2 == t2.h ? Bn(t2, xn, e2) : e2.push(xn(t2.g)), true);
}
var Qr = Vr((function(t2, e2, n2) {
  if (1 !== t2.h) return false;
  var r2 = t2.g;
  t2 = Sn(r2);
  const i2 = Sn(r2);
  r2 = 2 * (i2 >> 31) + 1;
  const s2 = i2 >>> 20 & 2047;
  return t2 = 4294967296 * (1048575 & i2) + t2, Hr(e2, n2, 2047 == s2 ? t2 ? NaN : r2 * (1 / 0) : 0 == s2 ? 5e-324 * r2 * t2 : r2 * Math.pow(2, s2 - 1075) * (t2 + 4503599627370496)), true;
}), (function(t2, e2, n2) {
  null != (e2 = $t(e2)) && (rr(t2, n2, 1), t2 = t2.g, (n2 = Mt || (Mt = new DataView(new ArrayBuffer(8)))).setFloat64(0, +e2, true), Pt = n2.getUint32(0, true), Ot = n2.getUint32(4, true), er(t2, Pt), er(t2, Ot));
}), cr());
var ti = Vr((function(t2, e2, n2) {
  return 5 === t2.h && (Hr(e2, n2, xn(t2.g)), true);
}), (function(t2, e2, n2) {
  null != (e2 = $t(e2)) && (rr(t2, n2, 5), t2 = t2.g, Dt(e2), er(t2, Pt));
}), gr);
var ei = Xr(Zr, (function(t2, e2, n2) {
  if (null != (e2 = jr($t, e2))) for (let o2 = 0; o2 < e2.length; o2++) {
    var r2 = t2, i2 = n2, s2 = e2[o2];
    null != s2 && (rr(r2, i2, 5), r2 = r2.g, Dt(s2), er(r2, Pt));
  }
}), gr);
var ni = Xr(Zr, (function(t2, e2, n2) {
  if (null != (e2 = jr($t, e2)) && e2.length) {
    rr(t2, n2, 2), Qn(t2.g, 4 * e2.length);
    for (let r2 = 0; r2 < e2.length; r2++) n2 = t2.g, Dt(e2[r2]), er(n2, Pt);
  }
}), gr);
var ri = Vr((function(t2, e2, n2) {
  return 0 === t2.h && (Hr(e2, n2, Tn(t2.g, Bt)), true);
}), zr, pr);
var ii = Vr((function(t2, e2, n2) {
  return 0 === t2.h && (Hr(e2, n2, 0 === (t2 = Tn(t2.g, Bt)) ? void 0 : t2), true);
}), zr, pr);
var si = Vr((function(t2, e2, n2) {
  return 0 === t2.h && (Hr(e2, n2, Tn(t2.g, Nt)), true);
}), (function(t2, e2, n2) {
  if (null != (e2 = se(e2))) {
    if ("string" == typeof e2) zn(e2);
    if (null != e2) switch (rr(t2, n2, 0), typeof e2) {
      case "number":
        t2 = t2.g, Ut(e2), Zn(t2, Pt, Ot);
        break;
      case "bigint":
        n2 = BigInt.asUintN(64, e2), n2 = new Kn(Number(n2 & BigInt(4294967295)), Number(n2 >> BigInt(32))), Zn(t2.g, n2.h, n2.g);
        break;
      default:
        n2 = zn(e2), Zn(t2.g, n2.h, n2.g);
    }
  }
}), cr());
var oi = Vr((function(t2, e2, n2) {
  return 0 === t2.h && (Hr(e2, n2, bn(t2.g)), true);
}), Kr, dr);
var ai = Xr((function(t2, e2, n2) {
  return (0 === t2.h || 2 === t2.h) && (e2 = Ye(e2, 0 | e2[Z], n2, false, false), 2 == t2.h ? Bn(t2, bn, e2) : e2.push(bn(t2.g)), true);
}), (function(t2, e2, n2) {
  if (null != (e2 = jr(Qt, e2)) && e2.length) {
    n2 = ir(t2, n2);
    for (let n3 = 0; n3 < e2.length; n3++) tr(t2.g, e2[n3]);
    sr(t2, n2);
  }
}), dr);
var ci = Vr((function(t2, e2, n2) {
  return 0 === t2.h && (Hr(e2, n2, 0 === (t2 = bn(t2.g)) ? void 0 : t2), true);
}), Kr, dr);
var hi = Vr((function(t2, e2, n2) {
  return 0 === t2.h && (Hr(e2, n2, An(t2.g)), true);
}), Yr, ur);
var ui = Vr((function(t2, e2, n2) {
  return 0 === t2.h && (Hr(e2, n2, false === (t2 = An(t2.g)) ? void 0 : t2), true);
}), Yr, ur);
var li = Xr((function(t2, e2, n2) {
  return 2 === t2.h && (t2 = Dn(t2), Ye(e2, 0 | e2[Z], n2, false).push(t2), true);
}), (function(t2, e2, n2) {
  if (null != (e2 = jr(ce, e2))) for (let o2 = 0; o2 < e2.length; o2++) {
    var r2 = t2, i2 = n2, s2 = e2[o2];
    null != s2 && or(r2, i2, c(s2));
  }
}), lr);
var di = Vr((function(t2, e2, n2) {
  return 2 === t2.h && (Hr(e2, n2, "" === (t2 = Dn(t2)) ? void 0 : t2), true);
}), $r, lr);
var fi = Vr((function(t2, e2, n2) {
  return 2 === t2.h && (Hr(e2, n2, Dn(t2)), true);
}), $r, lr);
var pi = (function(t2, e2, n2 = hr) {
  return new _r(t2, e2, n2);
})((function(t2, e2, n2, r2, i2) {
  return 2 === t2.h && (r2 = Fe(void 0, r2, true), Ye(e2, 0 | e2[Z], n2, true).push(r2), Un(t2, r2, i2), true);
}), (function(t2, e2, n2, r2, i2) {
  if (Array.isArray(e2)) for (let s2 = 0; s2 < e2.length; s2++) qr(t2, e2[s2], n2, r2, i2);
}));
var gi = vr((function(t2, e2, n2, r2, i2, s2) {
  return 2 === t2.h && (Je(e2, 0 | e2[Z], s2, n2), Un(t2, e2 = Qe(e2, r2, n2), i2), true);
}), qr);
var mi = Vr((function(t2, e2, n2) {
  return 2 === t2.h && (Hr(e2, n2, Nn(t2)), true);
}), Jr, mr);
var yi = Xr((function(t2, e2, n2) {
  return (0 === t2.h || 2 === t2.h) && (e2 = Ye(e2, 0 | e2[Z], n2, false, false), 2 == t2.h ? Bn(t2, kn, e2) : e2.push(kn(t2.g)), true);
}), (function(t2, e2, n2) {
  if (null != (e2 = jr(te, e2))) for (let o2 = 0; o2 < e2.length; o2++) {
    var r2 = t2, i2 = n2, s2 = e2[o2];
    null != s2 && (rr(r2, i2, 0), Qn(r2.g, s2));
  }
}), fr);
var _i = Vr((function(t2, e2, n2) {
  return 0 === t2.h && (Hr(e2, n2, 0 === (t2 = kn(t2.g)) ? void 0 : t2), true);
}), (function(t2, e2, n2) {
  null != (e2 = te(e2)) && null != e2 && (rr(t2, n2, 0), Qn(t2.g, e2));
}), fr);
var vi = Vr((function(t2, e2, n2) {
  return 0 === t2.h && (Hr(e2, n2, bn(t2.g)), true);
}), (function(t2, e2, n2) {
  null != (e2 = Qt(e2)) && (e2 = parseInt(e2, 10), rr(t2, n2, 0), tr(t2.g, e2));
}), yr);
var Ei = class {
  constructor(t2, e2) {
    this.h = t2, this.g = e2, this.l = en, this.m = sn, this.defaultValue = void 0;
  }
};
function wi(t2, e2) {
  return new Ei(t2, e2);
}
function Ti(t2, e2) {
  return (n2, r2) => {
    if (Gn.length) {
      const t3 = Gn.pop();
      t3.o(r2), Rn(t3.g, n2, r2), n2 = t3;
    } else n2 = new class {
      constructor(t3, e3) {
        if (Pn.length) {
          const n3 = Pn.pop();
          Rn(n3, t3, e3), t3 = n3;
        } else t3 = new class {
          constructor(t4, e4) {
            this.h = null, this.m = false, this.g = this.l = this.j = 0, Rn(this, t4, e4);
          }
          clear() {
            this.h = null, this.m = false, this.g = this.l = this.j = 0, this.ba = false;
          }
        }(t3, e3);
        this.g = t3, this.l = this.g.g, this.h = this.m = -1, this.o(e3);
      }
      o({ fa: t3 = false } = {}) {
        this.fa = t3;
      }
    }(n2, r2);
    try {
      const r3 = new t2(), s2 = r3.u;
      Or(e2)(s2, n2);
      var i2 = r3;
    } finally {
      n2.g.clear(), n2.m = -1, n2.h = -1, Gn.length < 100 && Gn.push(n2);
    }
    return i2;
  };
}
function Ai(t2) {
  return function() {
    const e2 = new class {
      constructor() {
        this.l = [], this.h = 0, this.g = new class {
          constructor() {
            this.g = [];
          }
          length() {
            return this.g.length;
          }
          end() {
            const t3 = this.g;
            return this.g = [], t3;
          }
        }();
      }
    }();
    Br(this.u, e2, Rr(Ar, Ur, Dr, t2)), nr(e2, e2.g.end());
    const n2 = new Uint8Array(e2.h), r2 = e2.l, i2 = r2.length;
    let s2 = 0;
    for (let t3 = 0; t3 < i2; t3++) {
      const e3 = r2[t3];
      n2.set(e3, s2), s2 += e3.length;
    }
    return e2.l = [n2], n2;
  };
}
var bi = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var ki = [0, di, Vr((function(t2, e2, n2) {
  return 2 === t2.h && (Hr(e2, n2, (t2 = Nn(t2)) === U() ? void 0 : t2), true);
}), (function(t2, e2, n2) {
  if (null != e2) {
    if (e2 instanceof Hn) {
      const r2 = e2.Ra;
      return void (r2 && (e2 = r2(e2), null != e2 && or(t2, n2, wn(e2).buffer)));
    }
    if (Array.isArray(e2)) return;
  }
  Jr(t2, e2, n2);
}), mr)];
var Si;
var xi = globalThis.trustedTypes;
function Li(t2) {
  void 0 === Si && (Si = (function() {
    let t3 = null;
    if (!xi) return t3;
    try {
      const e3 = (t4) => t4;
      t3 = xi.createPolicy("goog#html", { createHTML: e3, createScript: e3, createScriptURL: e3 });
    } catch (t4) {
    }
    return t3;
  })());
  var e2 = Si;
  return new class {
    constructor(t3) {
      this.g = t3;
    }
    toString() {
      return this.g + "";
    }
  }(e2 ? e2.createScriptURL(t2) : t2);
}
function Ri(t2, ...e2) {
  if (0 === e2.length) return Li(t2[0]);
  let n2 = t2[0];
  for (let r2 = 0; r2 < e2.length; r2++) n2 += encodeURIComponent(e2[r2]) + t2[r2 + 1];
  return Li(n2);
}
var Fi = [0, oi, vi, hi, -1, ai, vi, -1];
var Ii = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Mi = [0, hi, fi, hi, vi, -1, Xr((function(t2, e2, n2) {
  return (0 === t2.h || 2 === t2.h) && (e2 = Ye(e2, 0 | e2[Z], n2, false, false), 2 == t2.h ? Bn(t2, Ln, e2) : e2.push(bn(t2.g)), true);
}), (function(t2, e2, n2) {
  if (null != (e2 = jr(Qt, e2)) && e2.length) {
    n2 = ir(t2, n2);
    for (let n3 = 0; n3 < e2.length; n3++) tr(t2.g, e2[n3]);
    sr(t2, n2);
  }
}), yr), fi, -1, [0, hi, -1], vi, hi, -1];
var Pi = [0, fi, -2];
var Oi = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Ci = [0];
var Ui = [0, oi, hi, 1, hi, -3];
var Di = class extends Hn {
  constructor(t2) {
    super(t2, 2);
  }
};
var Ni = {};
Ni[336783863] = [0, fi, hi, -1, oi, [0, [1, 2, 3, 4, 5, 6, 7, 8], gi, Ci, gi, Mi, gi, Pi, gi, Ui, gi, Fi, gi, [0, fi, -2], gi, [0, fi, vi], gi, [0, vi, fi]], [0, fi], hi, [0, [1, 3], [2, 4], gi, [0, ai], -1, gi, [0, li], -1, pi, [0, fi, -1]], fi];
var Bi = [0, ii, -1, ui, -3, ii, ai, di, ci, ii, -1, ui, ci, ui, -2, di];
function Gi(t2, e2) {
  Ke(t2, 2, ae(e2), "");
}
function ji(t2, e2) {
  yn(t2, 3, e2);
}
function Vi(t2, e2) {
  yn(t2, 4, e2);
}
var Xi = class extends Hn {
  constructor(t2) {
    super(t2, 500);
  }
  o(t2) {
    return sn(this, 0, 7, t2);
  }
};
var Hi = [-1, {}];
var Wi = [0, fi, 1, Hi];
var zi = [0, fi, li, Hi];
function Ki(t2, e2) {
  hn(t2, 1, Xi, e2);
}
function Yi(t2, e2) {
  yn(t2, 10, e2);
}
function $i(t2, e2) {
  yn(t2, 15, e2);
}
var qi = class extends Hn {
  constructor(t2) {
    super(t2, 500);
  }
  o(t2) {
    return sn(this, 0, 1001, t2);
  }
};
var Ji = [-500, pi, [-500, di, -1, li, -3, [-2, Ni, hi], pi, ki, ci, -1, Wi, zi, pi, [0, di, ui], di, Bi, ci, li, 987, li], 4, pi, [-500, fi, -1, [-1, {}], 998, fi], pi, [-500, fi, li, -1, [-2, {}, hi], 997, li, -1], ci, pi, [-500, fi, li, Hi, 998, li], li, ci, Wi, zi, pi, [0, di, -1, Hi], li, -2, Bi, di, -1, ui, [0, ui, _i], 978, Hi, pi, ki];
qi.prototype.g = Ai(Ji);
var Zi = Ti(qi, Ji);
var Qi = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var ts = class extends Hn {
  constructor(t2) {
    super(t2);
  }
  g() {
    return rn(this, Qi, 1);
  }
};
var es = [0, pi, [0, oi, ti, fi, -1]];
var ns = Ti(ts, es);
var rs = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var is = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var ss = class extends Hn {
  constructor(t2) {
    super(t2);
  }
  h() {
    return en(this, rs, 2);
  }
  g() {
    return rn(this, is, 5);
  }
};
var os = Ti(class extends Hn {
  constructor(t2) {
    super(t2);
  }
}, [0, li, ai, ni, [0, vi, [0, oi, -3], [0, ti, -3], [0, oi, -1, [0, pi, [0, oi, -2]]], pi, [0, ti, -1, fi, ti]], fi, -1, ri, pi, [0, oi, ti], li, ri]);
var as = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var cs = Ti(class extends Hn {
  constructor(t2) {
    super(t2);
  }
}, [0, pi, [0, ti, -4]]);
var hs = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var us = Ti(class extends Hn {
  constructor(t2) {
    super(t2);
  }
}, [0, pi, [0, ti, -4]]);
var ls = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var ds = [0, oi, -1, ni, vi];
var fs = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
fs.prototype.g = Ai([0, ti, -4, ri]);
var ps = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var gs = Ti(class extends Hn {
  constructor(t2) {
    super(t2);
  }
}, [0, pi, [0, 1, oi, fi, es], ri]);
var ms = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var ys = class extends Hn {
  constructor(t2) {
    super(t2);
  }
  oa() {
    const t2 = Ge(this);
    return null == t2 ? U() : t2;
  }
};
var _s = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var vs = [1, 2];
var Es = Ti(class extends Hn {
  constructor(t2) {
    super(t2);
  }
}, [0, pi, [0, vs, gi, [0, ni], gi, [0, mi], oi, fi], ri]);
var ws = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Ts = [0, fi, oi, ti, li, -1];
var As = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var bs = [0, hi, -1];
var ks = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Ss = [1, 2, 3, 4, 5];
var xs = class extends Hn {
  constructor(t2) {
    super(t2);
  }
  g() {
    return null != Ge(this);
  }
  h() {
    return null != ln(this, 2);
  }
};
var Ls = class extends Hn {
  constructor(t2) {
    super(t2);
  }
  g() {
    return qt(Ce(this, 2)) ?? false;
  }
};
var Rs = [0, mi, fi, [0, oi, ri, -1], [0, si, ri]];
var Fs = [0, Rs, hi, [0, Ss, gi, Ui, gi, Mi, gi, Fi, gi, Ci, gi, Pi], vi];
var Is = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Ms = [0, Fs, ti, -1, oi];
var Ps = wi(502141897, Is);
Ni[502141897] = Ms;
var Os = Ti(class extends Hn {
  constructor(t2) {
    super(t2);
  }
}, [0, [0, vi, -1, ei, yi], ds]);
var Cs = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Us = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Ds = [0, Fs, ti, [0, Fs], hi];
var Ns = [0, Fs, Ms, Ds, ti, [0, [0, Rs]]];
var Bs = wi(508968150, Us);
Ni[508968150] = Ns, Ni[508968149] = Ds;
var Gs = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var js = wi(513916220, Gs);
Ni[513916220] = [0, Fs, Ns, oi];
var Vs = class extends Hn {
  constructor(t2) {
    super(t2);
  }
  h() {
    return en(this, ws, 2);
  }
  g() {
    De(this, 2);
  }
};
var Xs = [0, Fs, Ts];
Ni[478825465] = Xs;
var Hs = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Ws = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var zs = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Ks = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Ys = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var $s = [0, Fs, [0, Fs], Xs, -1];
var qs = [0, Fs, ti, oi];
var Js = [0, Fs, ti];
var Zs = [0, Fs, qs, Js, ti];
var Qs = wi(479097054, Ys);
Ni[479097054] = [0, Fs, Zs, $s], Ni[463370452] = $s, Ni[464864288] = qs;
var to = wi(462713202, Ks);
Ni[462713202] = Zs, Ni[474472470] = Js;
var eo = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var no = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var ro = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var io = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var so = [0, Fs, ti, -1, oi];
var oo = [0, Fs, ti, hi];
io.prototype.g = Ai([0, Fs, Js, [0, Fs], Ms, Ds, so, oo]);
var ao = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var co = wi(456383383, ao);
Ni[456383383] = [0, Fs, Ts];
var ho = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var uo = wi(476348187, ho);
Ni[476348187] = [0, Fs, bs];
var lo = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var fo = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var po = [0, vi, -1];
var go = wi(458105876, class extends Hn {
  constructor(t2) {
    super(t2);
  }
  g() {
    var t2 = this.u;
    const e2 = 0 | t2[Z];
    const n2 = 2 & e2;
    return t2 = (function(t3, e3, n3) {
      var r2 = fo;
      const i2 = 2 & e3;
      let s2 = false;
      if (null == n3) {
        if (i2) return be();
        n3 = [];
      } else if (n3.constructor === ye) {
        if (0 == (2 & n3.L) || i2) return n3;
        n3 = n3.X();
      } else Array.isArray(n3) ? s2 = !!(2 & (0 | n3[Z])) : n3 = [];
      if (i2) {
        if (!n3.length) return be();
        s2 || (s2 = true, rt(n3));
      } else s2 && (s2 = false, n3 = ze(n3));
      return s2 || (64 & (0 | n3[Z]) ? n3[Z] &= -33 : 32 & e3 && et(n3, 32)), Ne(t3, e3, 2, r2 = new ye(n3, r2, ue, void 0)), r2;
    })(t2, e2, Ue(t2, e2, 2)), !n2 && fo && (t2.ra = true), t2;
  }
});
Ni[458105876] = [0, po, Wr, [true, ri, [0, fi, -1, li]]];
var mo = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var yo = wi(458105758, mo);
Ni[458105758] = [0, Fs, fi, po];
var _o = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var vo = wi(443442058, _o);
Ni[443442058] = [0, Fs, fi, oi, ti, li, -1, hi, ti], Ni[514774813] = so;
var Eo = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var wo = wi(516587230, Eo);
function To(t2, e2) {
  return e2 = e2 ? e2.clone() : new ws(), void 0 !== t2.displayNamesLocale ? De(e2, 1, ae(t2.displayNamesLocale)) : void 0 === t2.displayNamesLocale && De(e2, 1), void 0 !== t2.maxResults ? pn(e2, 2, t2.maxResults) : "maxResults" in t2 && De(e2, 2), void 0 !== t2.scoreThreshold ? gn(e2, 3, t2.scoreThreshold) : "scoreThreshold" in t2 && De(e2, 3), void 0 !== t2.categoryAllowlist ? mn(e2, 4, t2.categoryAllowlist) : "categoryAllowlist" in t2 && De(e2, 4), void 0 !== t2.categoryDenylist ? mn(e2, 5, t2.categoryDenylist) : "categoryDenylist" in t2 && De(e2, 5), e2;
}
function Ao(t2, e2 = -1, n2 = "") {
  return { categories: t2.map(((t3) => ({ index: un(t3, 1) ?? 0 ?? -1, score: dn(t3, 2) ?? 0, categoryName: ln(t3, 3) ?? "" ?? "", displayName: ln(t3, 4) ?? "" ?? "" }))), headIndex: e2, headName: n2 };
}
function bo(t2) {
  var e2 = Ve(t2, 3, $t, je()), n2 = Ve(t2, 2, Qt, je()), r2 = Ve(t2, 1, ce, je()), i2 = Ve(t2, 9, ce, je());
  const s2 = { categories: [], keypoints: [] };
  for (let t3 = 0; t3 < e2.length; t3++) s2.categories.push({ score: e2[t3], index: n2[t3] ?? -1, categoryName: r2[t3] ?? "", displayName: i2[t3] ?? "" });
  if ((e2 = en(t2, ss, 4)?.h()) && (s2.boundingBox = { originX: un(e2, 1) ?? 0, originY: un(e2, 2) ?? 0, width: un(e2, 3) ?? 0, height: un(e2, 4) ?? 0, angle: 0 }), en(t2, ss, 4)?.g().length) for (const e3 of en(t2, ss, 4).g()) s2.keypoints.push({ x: Be(e3, 1) ?? 0, y: Be(e3, 2) ?? 0, score: Be(e3, 4) ?? 0, label: ln(e3, 3) ?? "" });
  return s2;
}
function ko(t2) {
  const e2 = [];
  for (const n2 of rn(t2, hs, 1)) e2.push({ x: dn(n2, 1) ?? 0, y: dn(n2, 2) ?? 0, z: dn(n2, 3) ?? 0, visibility: dn(n2, 4) ?? 0 });
  return e2;
}
function So(t2) {
  const e2 = [];
  for (const n2 of rn(t2, as, 1)) e2.push({ x: dn(n2, 1) ?? 0, y: dn(n2, 2) ?? 0, z: dn(n2, 3) ?? 0, visibility: dn(n2, 4) ?? 0 });
  return e2;
}
function xo(t2) {
  return Array.from(t2, ((t3) => t3 > 127 ? t3 - 256 : t3));
}
function Lo(t2, e2) {
  if (t2.length !== e2.length) throw Error(`Cannot compute cosine similarity between embeddings of different sizes (${t2.length} vs. ${e2.length}).`);
  let n2 = 0, r2 = 0, i2 = 0;
  for (let s2 = 0; s2 < t2.length; s2++) n2 += t2[s2] * e2[s2], r2 += t2[s2] * t2[s2], i2 += e2[s2] * e2[s2];
  if (r2 <= 0 || i2 <= 0) throw Error("Cannot compute cosine similarity on embedding with 0 norm.");
  return n2 / Math.sqrt(r2 * i2);
}
var Ro;
Ni[516587230] = [0, Fs, so, oo, ti], Ni[518928384] = oo;
var Fo = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
async function Io() {
  if (void 0 === Ro) try {
    await WebAssembly.instantiate(Fo), Ro = true;
  } catch {
    Ro = false;
  }
  return Ro;
}
async function Mo(t2, e2 = Ri``) {
  const n2 = await Io() ? "wasm_internal" : "wasm_nosimd_internal";
  return { wasmLoaderPath: `${e2}/${t2}_${n2}.js`, wasmBinaryPath: `${e2}/${t2}_${n2}.wasm` };
}
var Po = class {
};
function Oo() {
  var t2 = navigator;
  return "undefined" != typeof OffscreenCanvas && (!(function(t3 = navigator) {
    return (t3 = t3.userAgent).includes("Safari") && !t3.includes("Chrome");
  })(t2) || !!((t2 = t2.userAgent.match(/Version\/([\d]+).*Safari/)) && t2.length >= 1 && Number(t2[1]) >= 17));
}
async function Co(t2) {
  if ("function" != typeof importScripts) {
    const e2 = document.createElement("script");
    return e2.src = t2.toString(), e2.crossOrigin = "anonymous", new Promise(((t3, n2) => {
      e2.addEventListener("load", (() => {
        t3();
      }), false), e2.addEventListener("error", ((t4) => {
        n2(t4);
      }), false), document.body.appendChild(e2);
    }));
  }
  importScripts(t2.toString());
}
function Uo(t2) {
  return void 0 !== t2.videoWidth ? [t2.videoWidth, t2.videoHeight] : void 0 !== t2.naturalWidth ? [t2.naturalWidth, t2.naturalHeight] : void 0 !== t2.displayWidth ? [t2.displayWidth, t2.displayHeight] : [t2.width, t2.height];
}
function Do(t2, e2, n2) {
  t2.m || console.error("No wasm multistream support detected: ensure dependency inclusion of :gl_graph_runner_internal_multi_input target"), n2(e2 = t2.i.stringToNewUTF8(e2)), t2.i._free(e2);
}
function No(t2, e2, n2) {
  if (!t2.i.canvas) throw Error("No OpenGL canvas configured.");
  if (n2 ? t2.i._bindTextureToStream(n2) : t2.i._bindTextureToCanvas(), !(n2 = t2.i.canvas.getContext("webgl2") || t2.i.canvas.getContext("webgl"))) throw Error("Failed to obtain WebGL context from the provided canvas. `getContext()` should only be invoked with `webgl` or `webgl2`.");
  t2.i.gpuOriginForWebTexturesIsBottomLeft && n2.pixelStorei(n2.UNPACK_FLIP_Y_WEBGL, true), n2.texImage2D(n2.TEXTURE_2D, 0, n2.RGBA, n2.RGBA, n2.UNSIGNED_BYTE, e2), t2.i.gpuOriginForWebTexturesIsBottomLeft && n2.pixelStorei(n2.UNPACK_FLIP_Y_WEBGL, false);
  const [r2, i2] = Uo(e2);
  return !t2.l || r2 === t2.i.canvas.width && i2 === t2.i.canvas.height || (t2.i.canvas.width = r2, t2.i.canvas.height = i2), [r2, i2];
}
function Bo(t2, e2, n2) {
  t2.m || console.error("No wasm multistream support detected: ensure dependency inclusion of :gl_graph_runner_internal_multi_input target");
  const r2 = new Uint32Array(e2.length);
  for (let n3 = 0; n3 < e2.length; n3++) r2[n3] = t2.i.stringToNewUTF8(e2[n3]);
  e2 = t2.i._malloc(4 * r2.length), t2.i.HEAPU32.set(r2, e2 >> 2), n2(e2);
  for (const e3 of r2) t2.i._free(e3);
  t2.i._free(e2);
}
function Go(t2, e2, n2) {
  t2.i.simpleListeners = t2.i.simpleListeners || {}, t2.i.simpleListeners[e2] = n2;
}
function jo(t2, e2, n2) {
  let r2 = [];
  t2.i.simpleListeners = t2.i.simpleListeners || {}, t2.i.simpleListeners[e2] = (t3, e3, i2) => {
    e3 ? (n2(r2, i2), r2 = []) : r2.push(t3);
  };
}
Po.forVisionTasks = function(t2) {
  return Mo("vision", t2);
}, Po.forTextTasks = function(t2) {
  return Mo("text", t2);
}, Po.forGenAiExperimentalTasks = function(t2) {
  return Mo("genai_experimental", t2);
}, Po.forGenAiTasks = function(t2) {
  return Mo("genai", t2);
}, Po.forAudioTasks = function(t2) {
  return Mo("audio", t2);
}, Po.isSimdSupported = function() {
  return Io();
};
async function Vo(t2, e2, n2, r2) {
  return t2 = await (async (t3, e3, n3, r3, i2) => {
    if (e3 && await Co(e3), !self.ModuleFactory) throw Error("ModuleFactory not set.");
    if (n3 && (await Co(n3), !self.ModuleFactory)) throw Error("ModuleFactory not set.");
    return self.Module && i2 && ((e3 = self.Module).locateFile = i2.locateFile, i2.mainScriptUrlOrBlob && (e3.mainScriptUrlOrBlob = i2.mainScriptUrlOrBlob)), i2 = await self.ModuleFactory(self.Module || i2), self.ModuleFactory = self.Module = void 0, new t3(i2, r3);
  })(t2, n2.wasmLoaderPath, n2.assetLoaderPath, e2, { locateFile: (t3) => t3.endsWith(".wasm") ? n2.wasmBinaryPath.toString() : n2.assetBinaryPath && t3.endsWith(".data") ? n2.assetBinaryPath.toString() : t3 }), await t2.o(r2), t2;
}
function Xo(t2, e2) {
  const n2 = en(t2.baseOptions, xs, 1) || new xs();
  "string" == typeof e2 ? (De(n2, 2, ae(e2)), De(n2, 1)) : e2 instanceof Uint8Array && (De(n2, 1, ft(e2, false)), De(n2, 2)), sn(t2.baseOptions, 0, 1, n2);
}
function Ho(t2) {
  try {
    const e2 = t2.G.length;
    if (1 === e2) throw Error(t2.G[0].message);
    if (e2 > 1) throw Error("Encountered multiple errors: " + t2.G.map(((t3) => t3.message)).join(", "));
  } finally {
    t2.G = [];
  }
}
function Wo(t2, e2) {
  t2.B = Math.max(t2.B, e2);
}
function zo(t2, e2) {
  t2.A = new Xi(), Gi(t2.A, "PassThroughCalculator"), ji(t2.A, "free_memory"), Vi(t2.A, "free_memory_unused_out"), Yi(e2, "free_memory"), Ki(e2, t2.A);
}
function Ko(t2, e2) {
  ji(t2.A, e2), Vi(t2.A, e2 + "_unused_out");
}
function Yo(t2) {
  t2.g.addBoolToStream(true, "free_memory", t2.B);
}
var $o = class {
  constructor(t2) {
    this.g = t2, this.G = [], this.B = 0, this.g.setAutoRenderToScreen(false);
  }
  l(t2, e2 = true) {
    if (e2) {
      const e3 = t2.baseOptions || {};
      if (t2.baseOptions?.modelAssetBuffer && t2.baseOptions?.modelAssetPath) throw Error("Cannot set both baseOptions.modelAssetPath and baseOptions.modelAssetBuffer");
      if (!(en(this.baseOptions, xs, 1)?.g() || en(this.baseOptions, xs, 1)?.h() || t2.baseOptions?.modelAssetBuffer || t2.baseOptions?.modelAssetPath)) throw Error("Either baseOptions.modelAssetPath or baseOptions.modelAssetBuffer must be set");
      if ((function(t3, e4) {
        let n2 = en(t3.baseOptions, ks, 3);
        if (!n2) {
          var r2 = n2 = new ks(), i2 = new Oi();
          on(r2, 4, Ss, i2);
        }
        "delegate" in e4 && ("GPU" === e4.delegate ? (e4 = n2, r2 = new Ii(), on(e4, 2, Ss, r2)) : (e4 = n2, r2 = new Oi(), on(e4, 4, Ss, r2))), sn(t3.baseOptions, 0, 3, n2);
      })(this, e3), e3.modelAssetPath) return fetch(e3.modelAssetPath.toString()).then(((t3) => {
        if (t3.ok) return t3.arrayBuffer();
        throw Error(`Failed to fetch model: ${e3.modelAssetPath} (${t3.status})`);
      })).then(((t3) => {
        try {
          this.g.i.FS_unlink("/model.dat");
        } catch {
        }
        this.g.i.FS_createDataFile("/", "model.dat", new Uint8Array(t3), true, false, false), Xo(this, "/model.dat"), this.m(), this.I();
      }));
      if (e3.modelAssetBuffer instanceof Uint8Array) Xo(this, e3.modelAssetBuffer);
      else if (e3.modelAssetBuffer) return (async function(t3) {
        const e4 = [];
        for (var n2 = 0; ; ) {
          const { done: r2, value: i2 } = await t3.read();
          if (r2) break;
          e4.push(i2), n2 += i2.length;
        }
        if (0 === e4.length) return new Uint8Array(0);
        if (1 === e4.length) return e4[0];
        t3 = new Uint8Array(n2), n2 = 0;
        for (const r2 of e4) t3.set(r2, n2), n2 += r2.length;
        return t3;
      })(e3.modelAssetBuffer).then(((t3) => {
        Xo(this, t3), this.m(), this.I();
      }));
    }
    return this.m(), this.I(), Promise.resolve();
  }
  I() {
  }
  da() {
    let t2;
    if (this.g.da(((e2) => {
      t2 = Zi(e2);
    })), !t2) throw Error("Failed to retrieve CalculatorGraphConfig");
    return t2;
  }
  setGraph(t2, e2) {
    this.g.attachErrorListener(((t3, e3) => {
      this.G.push(Error(e3));
    })), this.g.La(), this.g.setGraph(t2, e2), this.A = void 0, Ho(this);
  }
  finishProcessing() {
    this.g.finishProcessing(), Ho(this);
  }
  close() {
    this.A = void 0, this.g.closeGraph();
  }
};
function qo(t2, e2) {
  if (!t2) throw Error(`Unable to obtain required WebGL resource: ${e2}`);
  return t2;
}
$o.prototype.close = $o.prototype.close, (function(e2, n2) {
  e2 = e2.split(".");
  var r2, i2 = t;
  e2[0] in i2 || void 0 === i2.execScript || i2.execScript("var " + e2[0]);
  for (; e2.length && (r2 = e2.shift()); ) e2.length || void 0 === n2 ? i2 = i2[r2] && i2[r2] !== Object.prototype[r2] ? i2[r2] : i2[r2] = {} : i2[r2] = n2;
})("TaskRunner", $o);
var Jo = class {
  constructor(t2, e2, n2, r2) {
    this.g = t2, this.h = e2, this.m = n2, this.l = r2;
  }
  bind() {
    this.g.bindVertexArray(this.h);
  }
  close() {
    this.g.deleteVertexArray(this.h), this.g.deleteBuffer(this.m), this.g.deleteBuffer(this.l);
  }
};
function Zo(t2, e2, n2) {
  const r2 = t2.g;
  if (n2 = qo(r2.createShader(n2), "Failed to create WebGL shader"), r2.shaderSource(n2, e2), r2.compileShader(n2), !r2.getShaderParameter(n2, r2.COMPILE_STATUS)) throw Error(`Could not compile WebGL shader: ${r2.getShaderInfoLog(n2)}`);
  return r2.attachShader(t2.h, n2), n2;
}
function Qo(t2, e2) {
  const n2 = t2.g, r2 = qo(n2.createVertexArray(), "Failed to create vertex array");
  n2.bindVertexArray(r2);
  const i2 = qo(n2.createBuffer(), "Failed to create buffer");
  n2.bindBuffer(n2.ARRAY_BUFFER, i2), n2.enableVertexAttribArray(t2.O), n2.vertexAttribPointer(t2.O, 2, n2.FLOAT, false, 0, 0), n2.bufferData(n2.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), n2.STATIC_DRAW);
  const s2 = qo(n2.createBuffer(), "Failed to create buffer");
  return n2.bindBuffer(n2.ARRAY_BUFFER, s2), n2.enableVertexAttribArray(t2.I), n2.vertexAttribPointer(t2.I, 2, n2.FLOAT, false, 0, 0), n2.bufferData(n2.ARRAY_BUFFER, new Float32Array(e2 ? [0, 1, 0, 0, 1, 0, 1, 1] : [0, 0, 0, 1, 1, 1, 1, 0]), n2.STATIC_DRAW), n2.bindBuffer(n2.ARRAY_BUFFER, null), n2.bindVertexArray(null), new Jo(n2, r2, i2, s2);
}
function ta(t2, e2) {
  if (t2.g) {
    if (e2 !== t2.g) throw Error("Cannot change GL context once initialized");
  } else t2.g = e2;
}
function ea(t2, e2, n2, r2) {
  return ta(t2, e2), t2.h || (t2.m(), t2.C()), n2 ? (t2.s || (t2.s = Qo(t2, true)), n2 = t2.s) : (t2.v || (t2.v = Qo(t2, false)), n2 = t2.v), e2.useProgram(t2.h), n2.bind(), t2.l(), t2 = r2(), n2.g.bindVertexArray(null), t2;
}
function na(t2, e2, n2) {
  return ta(t2, e2), t2 = qo(e2.createTexture(), "Failed to create texture"), e2.bindTexture(e2.TEXTURE_2D, t2), e2.texParameteri(e2.TEXTURE_2D, e2.TEXTURE_WRAP_S, e2.CLAMP_TO_EDGE), e2.texParameteri(e2.TEXTURE_2D, e2.TEXTURE_WRAP_T, e2.CLAMP_TO_EDGE), e2.texParameteri(e2.TEXTURE_2D, e2.TEXTURE_MIN_FILTER, n2 ?? e2.LINEAR), e2.texParameteri(e2.TEXTURE_2D, e2.TEXTURE_MAG_FILTER, n2 ?? e2.LINEAR), e2.bindTexture(e2.TEXTURE_2D, null), t2;
}
function ra(t2, e2, n2) {
  ta(t2, e2), t2.A || (t2.A = qo(e2.createFramebuffer(), "Failed to create framebuffe.")), e2.bindFramebuffer(e2.FRAMEBUFFER, t2.A), e2.framebufferTexture2D(e2.FRAMEBUFFER, e2.COLOR_ATTACHMENT0, e2.TEXTURE_2D, n2, 0);
}
function ia(t2) {
  t2.g?.bindFramebuffer(t2.g.FRAMEBUFFER, null);
}
var sa = class {
  G() {
    return "\n  precision mediump float;\n  varying vec2 vTex;\n  uniform sampler2D inputTexture;\n  void main() {\n    gl_FragColor = texture2D(inputTexture, vTex);\n  }\n ";
  }
  m() {
    const t2 = this.g;
    if (this.h = qo(t2.createProgram(), "Failed to create WebGL program"), this.aa = Zo(this, "\n  attribute vec2 aVertex;\n  attribute vec2 aTex;\n  varying vec2 vTex;\n  void main(void) {\n    gl_Position = vec4(aVertex, 0.0, 1.0);\n    vTex = aTex;\n  }", t2.VERTEX_SHADER), this.Z = Zo(this, this.G(), t2.FRAGMENT_SHADER), t2.linkProgram(this.h), !t2.getProgramParameter(this.h, t2.LINK_STATUS)) throw Error(`Error during program linking: ${t2.getProgramInfoLog(this.h)}`);
    this.O = t2.getAttribLocation(this.h, "aVertex"), this.I = t2.getAttribLocation(this.h, "aTex");
  }
  C() {
  }
  l() {
  }
  close() {
    if (this.h) {
      const t2 = this.g;
      t2.deleteProgram(this.h), t2.deleteShader(this.aa), t2.deleteShader(this.Z);
    }
    this.A && this.g.deleteFramebuffer(this.A), this.v && this.v.close(), this.s && this.s.close();
  }
};
var oa = class extends sa {
  G() {
    return "\n  precision mediump float;\n  uniform sampler2D backgroundTexture;\n  uniform sampler2D maskTexture;\n  uniform sampler2D colorMappingTexture;\n  varying vec2 vTex;\n  void main() {\n    vec4 backgroundColor = texture2D(backgroundTexture, vTex);\n    float category = texture2D(maskTexture, vTex).r;\n    vec4 categoryColor = texture2D(colorMappingTexture, vec2(category, 0.0));\n    gl_FragColor = mix(backgroundColor, categoryColor, categoryColor.a);\n  }\n ";
  }
  C() {
    const t2 = this.g;
    t2.activeTexture(t2.TEXTURE1), this.B = na(this, t2, t2.LINEAR), t2.activeTexture(t2.TEXTURE2), this.j = na(this, t2, t2.NEAREST);
  }
  m() {
    super.m();
    const t2 = this.g;
    this.K = qo(t2.getUniformLocation(this.h, "backgroundTexture"), "Uniform location"), this.T = qo(t2.getUniformLocation(this.h, "colorMappingTexture"), "Uniform location"), this.J = qo(t2.getUniformLocation(this.h, "maskTexture"), "Uniform location");
  }
  l() {
    super.l();
    const t2 = this.g;
    t2.uniform1i(this.J, 0), t2.uniform1i(this.K, 1), t2.uniform1i(this.T, 2);
  }
  close() {
    this.B && this.g.deleteTexture(this.B), this.j && this.g.deleteTexture(this.j), super.close();
  }
};
var aa = class extends sa {
  G() {
    return "\n  precision mediump float;\n  uniform sampler2D maskTexture;\n  uniform sampler2D defaultTexture;\n  uniform sampler2D overlayTexture;\n  varying vec2 vTex;\n  void main() {\n    float confidence = texture2D(maskTexture, vTex).r;\n    vec4 defaultColor = texture2D(defaultTexture, vTex);\n    vec4 overlayColor = texture2D(overlayTexture, vTex);\n    // Apply the alpha from the overlay and merge in the default color\n    overlayColor = mix(defaultColor, overlayColor, overlayColor.a);\n    gl_FragColor = mix(defaultColor, overlayColor, confidence);\n  }\n ";
  }
  C() {
    const t2 = this.g;
    t2.activeTexture(t2.TEXTURE1), this.j = na(this, t2), t2.activeTexture(t2.TEXTURE2), this.B = na(this, t2);
  }
  m() {
    super.m();
    const t2 = this.g;
    this.J = qo(t2.getUniformLocation(this.h, "defaultTexture"), "Uniform location"), this.K = qo(t2.getUniformLocation(this.h, "overlayTexture"), "Uniform location"), this.H = qo(t2.getUniformLocation(this.h, "maskTexture"), "Uniform location");
  }
  l() {
    super.l();
    const t2 = this.g;
    t2.uniform1i(this.H, 0), t2.uniform1i(this.J, 1), t2.uniform1i(this.K, 2);
  }
  close() {
    this.j && this.g.deleteTexture(this.j), this.B && this.g.deleteTexture(this.B), super.close();
  }
};
function ca(t2, e2) {
  switch (e2) {
    case 0:
      return t2.g.find(((t3) => t3 instanceof Uint8Array));
    case 1:
      return t2.g.find(((t3) => t3 instanceof Float32Array));
    case 2:
      return t2.g.find(((t3) => "undefined" != typeof WebGLTexture && t3 instanceof WebGLTexture));
    default:
      throw Error(`Type is not supported: ${e2}`);
  }
}
function ha(t2) {
  var e2 = ca(t2, 1);
  if (!e2) {
    if (e2 = ca(t2, 0)) e2 = new Float32Array(e2).map(((t3) => t3 / 255));
    else {
      e2 = new Float32Array(t2.width * t2.height);
      const r2 = la(t2);
      var n2 = fa(t2);
      if (ra(n2, r2, ua(t2)), "iPad Simulator;iPhone Simulator;iPod Simulator;iPad;iPhone;iPod".split(";").includes(navigator.platform) || navigator.userAgent.includes("Mac") && "document" in self && "ontouchend" in self.document) {
        n2 = new Float32Array(t2.width * t2.height * 4), r2.readPixels(0, 0, t2.width, t2.height, r2.RGBA, r2.FLOAT, n2);
        for (let t3 = 0, r3 = 0; t3 < e2.length; ++t3, r3 += 4) e2[t3] = n2[r3];
      } else r2.readPixels(0, 0, t2.width, t2.height, r2.RED, r2.FLOAT, e2);
    }
    t2.g.push(e2);
  }
  return e2;
}
function ua(t2) {
  let e2 = ca(t2, 2);
  if (!e2) {
    const n2 = la(t2);
    e2 = pa(t2);
    const r2 = ha(t2), i2 = da(t2);
    n2.texImage2D(n2.TEXTURE_2D, 0, i2, t2.width, t2.height, 0, n2.RED, n2.FLOAT, r2), ga(t2);
  }
  return e2;
}
function la(t2) {
  if (!t2.canvas) throw Error("Conversion to different image formats require that a canvas is passed when initializing the image.");
  return t2.h || (t2.h = qo(t2.canvas.getContext("webgl2"), "You cannot use a canvas that is already bound to a different type of rendering context.")), t2.h;
}
function da(t2) {
  if (t2 = la(t2), !ma) if (t2.getExtension("EXT_color_buffer_float") && t2.getExtension("OES_texture_float_linear") && t2.getExtension("EXT_float_blend")) ma = t2.R32F;
  else {
    if (!t2.getExtension("EXT_color_buffer_half_float")) throw Error("GPU does not fully support 4-channel float32 or float16 formats");
    ma = t2.R16F;
  }
  return ma;
}
function fa(t2) {
  return t2.l || (t2.l = new sa()), t2.l;
}
function pa(t2) {
  const e2 = la(t2);
  e2.viewport(0, 0, t2.width, t2.height), e2.activeTexture(e2.TEXTURE0);
  let n2 = ca(t2, 2);
  return n2 || (n2 = na(fa(t2), e2, t2.m ? e2.LINEAR : e2.NEAREST), t2.g.push(n2), t2.j = true), e2.bindTexture(e2.TEXTURE_2D, n2), n2;
}
function ga(t2) {
  t2.h.bindTexture(t2.h.TEXTURE_2D, null);
}
var ma;
var ya = class {
  constructor(t2, e2, n2, r2, i2, s2, o2) {
    this.g = t2, this.m = e2, this.j = n2, this.canvas = r2, this.l = i2, this.width = s2, this.height = o2, this.j && (0 === --_a && console.error("You seem to be creating MPMask instances without invoking .close(). This leaks resources."));
  }
  Fa() {
    return !!ca(this, 0);
  }
  ja() {
    return !!ca(this, 1);
  }
  P() {
    return !!ca(this, 2);
  }
  ia() {
    return (e2 = ca(t2 = this, 0)) || (e2 = ha(t2), e2 = new Uint8Array(e2.map(((t3) => 255 * t3))), t2.g.push(e2)), e2;
    var t2, e2;
  }
  ha() {
    return ha(this);
  }
  M() {
    return ua(this);
  }
  clone() {
    const t2 = [];
    for (const e2 of this.g) {
      let n2;
      if (e2 instanceof Uint8Array) n2 = new Uint8Array(e2);
      else if (e2 instanceof Float32Array) n2 = new Float32Array(e2);
      else {
        if (!(e2 instanceof WebGLTexture)) throw Error(`Type is not supported: ${e2}`);
        {
          const t3 = la(this), e3 = fa(this);
          t3.activeTexture(t3.TEXTURE1), n2 = na(e3, t3, this.m ? t3.LINEAR : t3.NEAREST), t3.bindTexture(t3.TEXTURE_2D, n2);
          const r2 = da(this);
          t3.texImage2D(t3.TEXTURE_2D, 0, r2, this.width, this.height, 0, t3.RED, t3.FLOAT, null), t3.bindTexture(t3.TEXTURE_2D, null), ra(e3, t3, n2), ea(e3, t3, false, (() => {
            pa(this), t3.clearColor(0, 0, 0, 0), t3.clear(t3.COLOR_BUFFER_BIT), t3.drawArrays(t3.TRIANGLE_FAN, 0, 4), ga(this);
          })), ia(e3), ga(this);
        }
      }
      t2.push(n2);
    }
    return new ya(t2, this.m, this.P(), this.canvas, this.l, this.width, this.height);
  }
  close() {
    this.j && la(this).deleteTexture(ca(this, 2)), _a = -1;
  }
};
ya.prototype.close = ya.prototype.close, ya.prototype.clone = ya.prototype.clone, ya.prototype.getAsWebGLTexture = ya.prototype.M, ya.prototype.getAsFloat32Array = ya.prototype.ha, ya.prototype.getAsUint8Array = ya.prototype.ia, ya.prototype.hasWebGLTexture = ya.prototype.P, ya.prototype.hasFloat32Array = ya.prototype.ja, ya.prototype.hasUint8Array = ya.prototype.Fa;
var _a = 250;
var va = { color: "white", lineWidth: 4, radius: 6 };
function Ea(t2) {
  return { ...va, fillColor: (t2 = t2 || {}).color, ...t2 };
}
function wa(t2, e2) {
  return t2 instanceof Function ? t2(e2) : t2;
}
function Ta(t2, e2, n2) {
  return Math.max(Math.min(e2, n2), Math.min(Math.max(e2, n2), t2));
}
function Aa(t2) {
  if (!t2.l) throw Error("CPU rendering requested but CanvasRenderingContext2D not provided.");
  return t2.l;
}
function ba(t2) {
  if (!t2.j) throw Error("GPU rendering requested but WebGL2RenderingContext not provided.");
  return t2.j;
}
function ka(t2, e2, n2) {
  if (e2.P()) n2(e2.M());
  else {
    const r2 = e2.ja() ? e2.ha() : e2.ia();
    t2.m = t2.m ?? new sa();
    const i2 = ba(t2);
    n2((t2 = new ya([r2], e2.m, false, i2.canvas, t2.m, e2.width, e2.height)).M()), t2.close();
  }
}
function Sa(t2, e2, n2, r2) {
  const i2 = (function(t3) {
    return t3.g || (t3.g = new oa()), t3.g;
  })(t2), s2 = ba(t2), o2 = Array.isArray(n2) ? new ImageData(new Uint8ClampedArray(n2), 1, 1) : n2;
  ea(i2, s2, true, (() => {
    !(function(t4, e3, n3, r3) {
      const i3 = t4.g;
      if (i3.activeTexture(i3.TEXTURE0), i3.bindTexture(i3.TEXTURE_2D, e3), i3.activeTexture(i3.TEXTURE1), i3.bindTexture(i3.TEXTURE_2D, t4.B), i3.texImage2D(i3.TEXTURE_2D, 0, i3.RGBA, i3.RGBA, i3.UNSIGNED_BYTE, n3), t4.H && (function(t5, e4) {
        if (t5 !== e4) return false;
        t5 = t5.entries(), e4 = e4.entries();
        for (const [r4, i4] of t5) {
          t5 = r4;
          const s3 = i4;
          var n4 = e4.next();
          if (n4.done) return false;
          const [o3, a2] = n4.value;
          if (n4 = a2, t5 !== o3 || s3[0] !== n4[0] || s3[1] !== n4[1] || s3[2] !== n4[2] || s3[3] !== n4[3]) return false;
        }
        return !!e4.next().done;
      })(t4.H, r3)) i3.activeTexture(i3.TEXTURE2), i3.bindTexture(i3.TEXTURE_2D, t4.j);
      else {
        t4.H = r3;
        const e4 = Array(1024).fill(0);
        r3.forEach(((t5, n4) => {
          if (4 !== t5.length) throw Error(`Color at index ${n4} is not a four-channel value.`);
          e4[4 * n4] = t5[0], e4[4 * n4 + 1] = t5[1], e4[4 * n4 + 2] = t5[2], e4[4 * n4 + 3] = t5[3];
        })), i3.activeTexture(i3.TEXTURE2), i3.bindTexture(i3.TEXTURE_2D, t4.j), i3.texImage2D(i3.TEXTURE_2D, 0, i3.RGBA, 256, 1, 0, i3.RGBA, i3.UNSIGNED_BYTE, new Uint8Array(e4));
      }
    })(i2, e2, o2, r2), s2.clearColor(0, 0, 0, 0), s2.clear(s2.COLOR_BUFFER_BIT), s2.drawArrays(s2.TRIANGLE_FAN, 0, 4);
    const t3 = i2.g;
    t3.activeTexture(t3.TEXTURE0), t3.bindTexture(t3.TEXTURE_2D, null), t3.activeTexture(t3.TEXTURE1), t3.bindTexture(t3.TEXTURE_2D, null), t3.activeTexture(t3.TEXTURE2), t3.bindTexture(t3.TEXTURE_2D, null);
  }));
}
function xa(t2, e2, n2, r2) {
  const i2 = ba(t2), s2 = (function(t3) {
    return t3.h || (t3.h = new aa()), t3.h;
  })(t2), o2 = Array.isArray(n2) ? new ImageData(new Uint8ClampedArray(n2), 1, 1) : n2, a2 = Array.isArray(r2) ? new ImageData(new Uint8ClampedArray(r2), 1, 1) : r2;
  ea(s2, i2, true, (() => {
    var t3 = s2.g;
    t3.activeTexture(t3.TEXTURE0), t3.bindTexture(t3.TEXTURE_2D, e2), t3.activeTexture(t3.TEXTURE1), t3.bindTexture(t3.TEXTURE_2D, s2.j), t3.texImage2D(t3.TEXTURE_2D, 0, t3.RGBA, t3.RGBA, t3.UNSIGNED_BYTE, o2), t3.activeTexture(t3.TEXTURE2), t3.bindTexture(t3.TEXTURE_2D, s2.B), t3.texImage2D(t3.TEXTURE_2D, 0, t3.RGBA, t3.RGBA, t3.UNSIGNED_BYTE, a2), i2.clearColor(0, 0, 0, 0), i2.clear(i2.COLOR_BUFFER_BIT), i2.drawArrays(i2.TRIANGLE_FAN, 0, 4), i2.bindTexture(i2.TEXTURE_2D, null), (t3 = s2.g).activeTexture(t3.TEXTURE0), t3.bindTexture(t3.TEXTURE_2D, null), t3.activeTexture(t3.TEXTURE1), t3.bindTexture(t3.TEXTURE_2D, null), t3.activeTexture(t3.TEXTURE2), t3.bindTexture(t3.TEXTURE_2D, null);
  }));
}
var La = class {
  constructor(t2, e2) {
    t2 instanceof CanvasRenderingContext2D || t2 instanceof OffscreenCanvasRenderingContext2D ? (this.l = t2, this.j = e2) : this.j = t2;
  }
  ya(t2, e2) {
    if (t2) {
      var n2 = Aa(this);
      e2 = Ea(e2), n2.save();
      var r2 = n2.canvas, i2 = 0;
      for (const s2 of t2) n2.fillStyle = wa(e2.fillColor, { index: i2, from: s2 }), n2.strokeStyle = wa(e2.color, { index: i2, from: s2 }), n2.lineWidth = wa(e2.lineWidth, { index: i2, from: s2 }), (t2 = new Path2D()).arc(s2.x * r2.width, s2.y * r2.height, wa(e2.radius, { index: i2, from: s2 }), 0, 2 * Math.PI), n2.fill(t2), n2.stroke(t2), ++i2;
      n2.restore();
    }
  }
  xa(t2, e2, n2) {
    if (t2 && e2) {
      var r2 = Aa(this);
      n2 = Ea(n2), r2.save();
      var i2 = r2.canvas, s2 = 0;
      for (const o2 of e2) {
        r2.beginPath(), e2 = t2[o2.start];
        const a2 = t2[o2.end];
        e2 && a2 && (r2.strokeStyle = wa(n2.color, { index: s2, from: e2, to: a2 }), r2.lineWidth = wa(n2.lineWidth, { index: s2, from: e2, to: a2 }), r2.moveTo(e2.x * i2.width, e2.y * i2.height), r2.lineTo(a2.x * i2.width, a2.y * i2.height)), ++s2, r2.stroke();
      }
      r2.restore();
    }
  }
  ua(t2, e2) {
    const n2 = Aa(this);
    e2 = Ea(e2), n2.save(), n2.beginPath(), n2.lineWidth = wa(e2.lineWidth, {}), n2.strokeStyle = wa(e2.color, {}), n2.fillStyle = wa(e2.fillColor, {}), n2.moveTo(t2.originX, t2.originY), n2.lineTo(t2.originX + t2.width, t2.originY), n2.lineTo(t2.originX + t2.width, t2.originY + t2.height), n2.lineTo(t2.originX, t2.originY + t2.height), n2.lineTo(t2.originX, t2.originY), n2.stroke(), n2.fill(), n2.restore();
  }
  va(t2, e2, n2 = [0, 0, 0, 255]) {
    this.l ? (function(t3, e3, n3, r2) {
      const i2 = ba(t3);
      ka(t3, e3, ((e4) => {
        Sa(t3, e4, n3, r2), (e4 = Aa(t3)).drawImage(i2.canvas, 0, 0, e4.canvas.width, e4.canvas.height);
      }));
    })(this, t2, n2, e2) : Sa(this, t2.M(), n2, e2);
  }
  wa(t2, e2, n2) {
    this.l ? (function(t3, e3, n3, r2) {
      const i2 = ba(t3);
      ka(t3, e3, ((e4) => {
        xa(t3, e4, n3, r2), (e4 = Aa(t3)).drawImage(i2.canvas, 0, 0, e4.canvas.width, e4.canvas.height);
      }));
    })(this, t2, e2, n2) : xa(this, t2.M(), e2, n2);
  }
  close() {
    this.g?.close(), this.g = void 0, this.h?.close(), this.h = void 0, this.m?.close(), this.m = void 0;
  }
};
function Ra(t2, e2) {
  switch (e2) {
    case 0:
      return t2.g.find(((t3) => t3 instanceof ImageData));
    case 1:
      return t2.g.find(((t3) => "undefined" != typeof ImageBitmap && t3 instanceof ImageBitmap));
    case 2:
      return t2.g.find(((t3) => "undefined" != typeof WebGLTexture && t3 instanceof WebGLTexture));
    default:
      throw Error(`Type is not supported: ${e2}`);
  }
}
function Fa(t2) {
  var e2 = Ra(t2, 0);
  if (!e2) {
    e2 = Ma(t2);
    const n2 = Pa(t2), r2 = new Uint8Array(t2.width * t2.height * 4);
    ra(n2, e2, Ia(t2)), e2.readPixels(0, 0, t2.width, t2.height, e2.RGBA, e2.UNSIGNED_BYTE, r2), ia(n2), e2 = new ImageData(new Uint8ClampedArray(r2.buffer), t2.width, t2.height), t2.g.push(e2);
  }
  return e2;
}
function Ia(t2) {
  let e2 = Ra(t2, 2);
  if (!e2) {
    const n2 = Ma(t2);
    e2 = Oa(t2);
    const r2 = Ra(t2, 1) || Fa(t2);
    n2.texImage2D(n2.TEXTURE_2D, 0, n2.RGBA, n2.RGBA, n2.UNSIGNED_BYTE, r2), Ca(t2);
  }
  return e2;
}
function Ma(t2) {
  if (!t2.canvas) throw Error("Conversion to different image formats require that a canvas is passed when initializing the image.");
  return t2.h || (t2.h = qo(t2.canvas.getContext("webgl2"), "You cannot use a canvas that is already bound to a different type of rendering context.")), t2.h;
}
function Pa(t2) {
  return t2.l || (t2.l = new sa()), t2.l;
}
function Oa(t2) {
  const e2 = Ma(t2);
  e2.viewport(0, 0, t2.width, t2.height), e2.activeTexture(e2.TEXTURE0);
  let n2 = Ra(t2, 2);
  return n2 || (n2 = na(Pa(t2), e2), t2.g.push(n2), t2.m = true), e2.bindTexture(e2.TEXTURE_2D, n2), n2;
}
function Ca(t2) {
  t2.h.bindTexture(t2.h.TEXTURE_2D, null);
}
function Ua(t2) {
  const e2 = Ma(t2);
  return ea(Pa(t2), e2, true, (() => (function(t3, e3) {
    const n2 = t3.canvas;
    if (n2.width === t3.width && n2.height === t3.height) return e3();
    const r2 = n2.width, i2 = n2.height;
    return n2.width = t3.width, n2.height = t3.height, t3 = e3(), n2.width = r2, n2.height = i2, t3;
  })(t2, (() => {
    if (e2.bindFramebuffer(e2.FRAMEBUFFER, null), e2.clearColor(0, 0, 0, 0), e2.clear(e2.COLOR_BUFFER_BIT), e2.drawArrays(e2.TRIANGLE_FAN, 0, 4), !(t2.canvas instanceof OffscreenCanvas)) throw Error("Conversion to ImageBitmap requires that the MediaPipe Tasks is initialized with an OffscreenCanvas");
    return t2.canvas.transferToImageBitmap();
  }))));
}
La.prototype.close = La.prototype.close, La.prototype.drawConfidenceMask = La.prototype.wa, La.prototype.drawCategoryMask = La.prototype.va, La.prototype.drawBoundingBox = La.prototype.ua, La.prototype.drawConnectors = La.prototype.xa, La.prototype.drawLandmarks = La.prototype.ya, La.lerp = function(t2, e2, n2, r2, i2) {
  return Ta(r2 * (1 - (t2 - e2) / (n2 - e2)) + i2 * (1 - (n2 - t2) / (n2 - e2)), r2, i2);
}, La.clamp = Ta;
var Da = class {
  constructor(t2, e2, n2, r2, i2, s2, o2) {
    this.g = t2, this.j = e2, this.m = n2, this.canvas = r2, this.l = i2, this.width = s2, this.height = o2, (this.j || this.m) && (0 === --Na && console.error("You seem to be creating MPImage instances without invoking .close(). This leaks resources."));
  }
  Ea() {
    return !!Ra(this, 0);
  }
  ka() {
    return !!Ra(this, 1);
  }
  P() {
    return !!Ra(this, 2);
  }
  Ca() {
    return Fa(this);
  }
  Ba() {
    var t2 = Ra(this, 1);
    return t2 || (Ia(this), Oa(this), t2 = Ua(this), Ca(this), this.g.push(t2), this.j = true), t2;
  }
  M() {
    return Ia(this);
  }
  clone() {
    const t2 = [];
    for (const e2 of this.g) {
      let n2;
      if (e2 instanceof ImageData) n2 = new ImageData(e2.data, this.width, this.height);
      else if (e2 instanceof WebGLTexture) {
        const t3 = Ma(this), e3 = Pa(this);
        t3.activeTexture(t3.TEXTURE1), n2 = na(e3, t3), t3.bindTexture(t3.TEXTURE_2D, n2), t3.texImage2D(t3.TEXTURE_2D, 0, t3.RGBA, this.width, this.height, 0, t3.RGBA, t3.UNSIGNED_BYTE, null), t3.bindTexture(t3.TEXTURE_2D, null), ra(e3, t3, n2), ea(e3, t3, false, (() => {
          Oa(this), t3.clearColor(0, 0, 0, 0), t3.clear(t3.COLOR_BUFFER_BIT), t3.drawArrays(t3.TRIANGLE_FAN, 0, 4), Ca(this);
        })), ia(e3), Ca(this);
      } else {
        if (!(e2 instanceof ImageBitmap)) throw Error(`Type is not supported: ${e2}`);
        Ia(this), Oa(this), n2 = Ua(this), Ca(this);
      }
      t2.push(n2);
    }
    return new Da(t2, this.ka(), this.P(), this.canvas, this.l, this.width, this.height);
  }
  close() {
    this.j && Ra(this, 1).close(), this.m && Ma(this).deleteTexture(Ra(this, 2)), Na = -1;
  }
};
Da.prototype.close = Da.prototype.close, Da.prototype.clone = Da.prototype.clone, Da.prototype.getAsWebGLTexture = Da.prototype.M, Da.prototype.getAsImageBitmap = Da.prototype.Ba, Da.prototype.getAsImageData = Da.prototype.Ca, Da.prototype.hasWebGLTexture = Da.prototype.P, Da.prototype.hasImageBitmap = Da.prototype.ka, Da.prototype.hasImageData = Da.prototype.Ea;
var Na = 250;
function Ba(...t2) {
  return t2.map((([t3, e2]) => ({ start: t3, end: e2 })));
}
var Ga = /* @__PURE__ */ (function(t2) {
  return class extends t2 {
    La() {
      this.i._registerModelResourcesGraphService();
    }
  };
})((ja = class {
  constructor(t2, e2) {
    this.l = true, this.i = t2, this.g = null, this.h = 0, this.m = "function" == typeof this.i._addIntToInputStream, void 0 !== e2 ? this.i.canvas = e2 : Oo() ? this.i.canvas = new OffscreenCanvas(1, 1) : (console.warn("OffscreenCanvas not supported and GraphRunner constructor glCanvas parameter is undefined. Creating backup canvas."), this.i.canvas = document.createElement("canvas"));
  }
  async initializeGraph(t2) {
    const e2 = await (await fetch(t2)).arrayBuffer();
    t2 = !(t2.endsWith(".pbtxt") || t2.endsWith(".textproto")), this.setGraph(new Uint8Array(e2), t2);
  }
  setGraphFromString(t2) {
    this.setGraph(new TextEncoder().encode(t2), false);
  }
  setGraph(t2, e2) {
    const n2 = t2.length, r2 = this.i._malloc(n2);
    this.i.HEAPU8.set(t2, r2), e2 ? this.i._changeBinaryGraph(n2, r2) : this.i._changeTextGraph(n2, r2), this.i._free(r2);
  }
  configureAudio(t2, e2, n2, r2, i2) {
    this.i._configureAudio || console.warn('Attempting to use configureAudio without support for input audio. Is build dep ":gl_graph_runner_audio" missing?'), Do(this, r2 || "input_audio", ((r3) => {
      Do(this, i2 = i2 || "audio_header", ((i3) => {
        this.i._configureAudio(r3, i3, t2, e2 ?? 0, n2);
      }));
    }));
  }
  setAutoResizeCanvas(t2) {
    this.l = t2;
  }
  setAutoRenderToScreen(t2) {
    this.i._setAutoRenderToScreen(t2);
  }
  setGpuBufferVerticalFlip(t2) {
    this.i.gpuOriginForWebTexturesIsBottomLeft = t2;
  }
  da(t2) {
    Go(this, "__graph_config__", ((e2) => {
      t2(e2);
    })), Do(this, "__graph_config__", ((t3) => {
      this.i._getGraphConfig(t3, void 0);
    })), delete this.i.simpleListeners.__graph_config__;
  }
  attachErrorListener(t2) {
    this.i.errorListener = t2;
  }
  attachEmptyPacketListener(t2, e2) {
    this.i.emptyPacketListeners = this.i.emptyPacketListeners || {}, this.i.emptyPacketListeners[t2] = e2;
  }
  addAudioToStream(t2, e2, n2) {
    this.addAudioToStreamWithShape(t2, 0, 0, e2, n2);
  }
  addAudioToStreamWithShape(t2, e2, n2, r2, i2) {
    const s2 = 4 * t2.length;
    this.h !== s2 && (this.g && this.i._free(this.g), this.g = this.i._malloc(s2), this.h = s2), this.i.HEAPF32.set(t2, this.g / 4), Do(this, r2, ((t3) => {
      this.i._addAudioToInputStream(this.g, e2, n2, t3, i2);
    }));
  }
  addGpuBufferToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      const [r2, i2] = No(this, t2, e3);
      this.i._addBoundTextureToStream(e3, r2, i2, n2);
    }));
  }
  addBoolToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      this.i._addBoolToInputStream(t2, e3, n2);
    }));
  }
  addDoubleToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      this.i._addDoubleToInputStream(t2, e3, n2);
    }));
  }
  addFloatToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      this.i._addFloatToInputStream(t2, e3, n2);
    }));
  }
  addIntToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      this.i._addIntToInputStream(t2, e3, n2);
    }));
  }
  addUintToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      this.i._addUintToInputStream(t2, e3, n2);
    }));
  }
  addStringToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      Do(this, t2, ((t3) => {
        this.i._addStringToInputStream(t3, e3, n2);
      }));
    }));
  }
  addStringRecordToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      Bo(this, Object.keys(t2), ((r2) => {
        Bo(this, Object.values(t2), ((i2) => {
          this.i._addFlatHashMapToInputStream(r2, i2, Object.keys(t2).length, e3, n2);
        }));
      }));
    }));
  }
  addProtoToStream(t2, e2, n2, r2) {
    Do(this, n2, ((n3) => {
      Do(this, e2, ((e3) => {
        const i2 = this.i._malloc(t2.length);
        this.i.HEAPU8.set(t2, i2), this.i._addProtoToInputStream(i2, t2.length, e3, n3, r2), this.i._free(i2);
      }));
    }));
  }
  addEmptyPacketToStream(t2, e2) {
    Do(this, t2, ((t3) => {
      this.i._addEmptyPacketToInputStream(t3, e2);
    }));
  }
  addBoolVectorToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      const r2 = this.i._allocateBoolVector(t2.length);
      if (!r2) throw Error("Unable to allocate new bool vector on heap.");
      for (const e4 of t2) this.i._addBoolVectorEntry(r2, e4);
      this.i._addBoolVectorToInputStream(r2, e3, n2);
    }));
  }
  addDoubleVectorToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      const r2 = this.i._allocateDoubleVector(t2.length);
      if (!r2) throw Error("Unable to allocate new double vector on heap.");
      for (const e4 of t2) this.i._addDoubleVectorEntry(r2, e4);
      this.i._addDoubleVectorToInputStream(r2, e3, n2);
    }));
  }
  addFloatVectorToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      const r2 = this.i._allocateFloatVector(t2.length);
      if (!r2) throw Error("Unable to allocate new float vector on heap.");
      for (const e4 of t2) this.i._addFloatVectorEntry(r2, e4);
      this.i._addFloatVectorToInputStream(r2, e3, n2);
    }));
  }
  addIntVectorToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      const r2 = this.i._allocateIntVector(t2.length);
      if (!r2) throw Error("Unable to allocate new int vector on heap.");
      for (const e4 of t2) this.i._addIntVectorEntry(r2, e4);
      this.i._addIntVectorToInputStream(r2, e3, n2);
    }));
  }
  addUintVectorToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      const r2 = this.i._allocateUintVector(t2.length);
      if (!r2) throw Error("Unable to allocate new unsigned int vector on heap.");
      for (const e4 of t2) this.i._addUintVectorEntry(r2, e4);
      this.i._addUintVectorToInputStream(r2, e3, n2);
    }));
  }
  addStringVectorToStream(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      const r2 = this.i._allocateStringVector(t2.length);
      if (!r2) throw Error("Unable to allocate new string vector on heap.");
      for (const e4 of t2) Do(this, e4, ((t3) => {
        this.i._addStringVectorEntry(r2, t3);
      }));
      this.i._addStringVectorToInputStream(r2, e3, n2);
    }));
  }
  addBoolToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      this.i._addBoolToInputSidePacket(t2, e3);
    }));
  }
  addDoubleToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      this.i._addDoubleToInputSidePacket(t2, e3);
    }));
  }
  addFloatToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      this.i._addFloatToInputSidePacket(t2, e3);
    }));
  }
  addIntToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      this.i._addIntToInputSidePacket(t2, e3);
    }));
  }
  addUintToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      this.i._addUintToInputSidePacket(t2, e3);
    }));
  }
  addStringToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      Do(this, t2, ((t3) => {
        this.i._addStringToInputSidePacket(t3, e3);
      }));
    }));
  }
  addProtoToInputSidePacket(t2, e2, n2) {
    Do(this, n2, ((n3) => {
      Do(this, e2, ((e3) => {
        const r2 = this.i._malloc(t2.length);
        this.i.HEAPU8.set(t2, r2), this.i._addProtoToInputSidePacket(r2, t2.length, e3, n3), this.i._free(r2);
      }));
    }));
  }
  addBoolVectorToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      const n2 = this.i._allocateBoolVector(t2.length);
      if (!n2) throw Error("Unable to allocate new bool vector on heap.");
      for (const e4 of t2) this.i._addBoolVectorEntry(n2, e4);
      this.i._addBoolVectorToInputSidePacket(n2, e3);
    }));
  }
  addDoubleVectorToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      const n2 = this.i._allocateDoubleVector(t2.length);
      if (!n2) throw Error("Unable to allocate new double vector on heap.");
      for (const e4 of t2) this.i._addDoubleVectorEntry(n2, e4);
      this.i._addDoubleVectorToInputSidePacket(n2, e3);
    }));
  }
  addFloatVectorToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      const n2 = this.i._allocateFloatVector(t2.length);
      if (!n2) throw Error("Unable to allocate new float vector on heap.");
      for (const e4 of t2) this.i._addFloatVectorEntry(n2, e4);
      this.i._addFloatVectorToInputSidePacket(n2, e3);
    }));
  }
  addIntVectorToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      const n2 = this.i._allocateIntVector(t2.length);
      if (!n2) throw Error("Unable to allocate new int vector on heap.");
      for (const e4 of t2) this.i._addIntVectorEntry(n2, e4);
      this.i._addIntVectorToInputSidePacket(n2, e3);
    }));
  }
  addUintVectorToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      const n2 = this.i._allocateUintVector(t2.length);
      if (!n2) throw Error("Unable to allocate new unsigned int vector on heap.");
      for (const e4 of t2) this.i._addUintVectorEntry(n2, e4);
      this.i._addUintVectorToInputSidePacket(n2, e3);
    }));
  }
  addStringVectorToInputSidePacket(t2, e2) {
    Do(this, e2, ((e3) => {
      const n2 = this.i._allocateStringVector(t2.length);
      if (!n2) throw Error("Unable to allocate new string vector on heap.");
      for (const e4 of t2) Do(this, e4, ((t3) => {
        this.i._addStringVectorEntry(n2, t3);
      }));
      this.i._addStringVectorToInputSidePacket(n2, e3);
    }));
  }
  attachBoolListener(t2, e2) {
    Go(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachBoolListener(t3);
    }));
  }
  attachBoolVectorListener(t2, e2) {
    jo(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachBoolVectorListener(t3);
    }));
  }
  attachIntListener(t2, e2) {
    Go(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachIntListener(t3);
    }));
  }
  attachIntVectorListener(t2, e2) {
    jo(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachIntVectorListener(t3);
    }));
  }
  attachUintListener(t2, e2) {
    Go(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachUintListener(t3);
    }));
  }
  attachUintVectorListener(t2, e2) {
    jo(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachUintVectorListener(t3);
    }));
  }
  attachDoubleListener(t2, e2) {
    Go(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachDoubleListener(t3);
    }));
  }
  attachDoubleVectorListener(t2, e2) {
    jo(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachDoubleVectorListener(t3);
    }));
  }
  attachFloatListener(t2, e2) {
    Go(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachFloatListener(t3);
    }));
  }
  attachFloatVectorListener(t2, e2) {
    jo(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachFloatVectorListener(t3);
    }));
  }
  attachStringListener(t2, e2) {
    Go(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachStringListener(t3);
    }));
  }
  attachStringVectorListener(t2, e2) {
    jo(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachStringVectorListener(t3);
    }));
  }
  attachProtoListener(t2, e2, n2) {
    Go(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachProtoListener(t3, n2 || false);
    }));
  }
  attachProtoVectorListener(t2, e2, n2) {
    jo(this, t2, e2), Do(this, t2, ((t3) => {
      this.i._attachProtoVectorListener(t3, n2 || false);
    }));
  }
  attachAudioListener(t2, e2, n2) {
    this.i._attachAudioListener || console.warn('Attempting to use attachAudioListener without support for output audio. Is build dep ":gl_graph_runner_audio_out" missing?'), Go(this, t2, ((t3, n3) => {
      t3 = new Float32Array(t3.buffer, t3.byteOffset, t3.length / 4), e2(t3, n3);
    })), Do(this, t2, ((t3) => {
      this.i._attachAudioListener(t3, n2 || false);
    }));
  }
  finishProcessing() {
    this.i._waitUntilIdle();
  }
  closeGraph() {
    this.i._closeGraph(), this.i.simpleListeners = void 0, this.i.emptyPacketListeners = void 0;
  }
}, class extends ja {
  get ea() {
    return this.i;
  }
  qa(t2, e2, n2) {
    Do(this, e2, ((e3) => {
      const [r2, i2] = No(this, t2, e3);
      this.ea._addBoundTextureAsImageToStream(e3, r2, i2, n2);
    }));
  }
  U(t2, e2) {
    Go(this, t2, e2), Do(this, t2, ((t3) => {
      this.ea._attachImageListener(t3);
    }));
  }
  ca(t2, e2) {
    jo(this, t2, e2), Do(this, t2, ((t3) => {
      this.ea._attachImageVectorListener(t3);
    }));
  }
}));
var ja;
var Va = class extends Ga {
};
async function Xa(t2, e2, n2) {
  return (async function(t3, e3, n3, r2) {
    return Vo(t3, e3, n3, r2);
  })(t2, n2.canvas ?? (Oo() ? void 0 : document.createElement("canvas")), e2, n2);
}
function Ha(t2, e2, n2, r2) {
  if (t2.T) {
    const s2 = new fs();
    if (n2?.regionOfInterest) {
      if (!t2.pa) throw Error("This task doesn't support region-of-interest.");
      var i2 = n2.regionOfInterest;
      if (i2.left >= i2.right || i2.top >= i2.bottom) throw Error("Expected RectF with left < right and top < bottom.");
      if (i2.left < 0 || i2.top < 0 || i2.right > 1 || i2.bottom > 1) throw Error("Expected RectF values to be in [0,1].");
      gn(s2, 1, (i2.left + i2.right) / 2), gn(s2, 2, (i2.top + i2.bottom) / 2), gn(s2, 4, i2.right - i2.left), gn(s2, 3, i2.bottom - i2.top);
    } else gn(s2, 1, 0.5), gn(s2, 2, 0.5), gn(s2, 4, 1), gn(s2, 3, 1);
    if (n2?.rotationDegrees) {
      if (n2?.rotationDegrees % 90 != 0) throw Error("Expected rotation to be a multiple of 90\xB0.");
      if (gn(s2, 5, -Math.PI * n2.rotationDegrees / 180), n2?.rotationDegrees % 180 != 0) {
        const [t3, r3] = Uo(e2);
        n2 = dn(s2, 3) * r3 / t3, i2 = dn(s2, 4) * t3 / r3, gn(s2, 4, n2), gn(s2, 3, i2);
      }
    }
    t2.g.addProtoToStream(s2.g(), "mediapipe.NormalizedRect", t2.T, r2);
  }
  t2.g.qa(e2, t2.aa, r2 ?? performance.now()), t2.finishProcessing();
}
function Wa(t2, e2, n2) {
  if (t2.baseOptions?.g()) throw Error("Task is not initialized with image mode. 'runningMode' must be set to 'IMAGE'.");
  Ha(t2, e2, n2, t2.B + 1);
}
function za(t2, e2, n2, r2) {
  if (!t2.baseOptions?.g()) throw Error("Task is not initialized with video mode. 'runningMode' must be set to 'VIDEO'.");
  Ha(t2, e2, n2, r2);
}
function Ka(t2, e2, n2, r2) {
  var i2 = e2.data;
  const s2 = e2.width, o2 = s2 * (e2 = e2.height);
  if ((i2 instanceof Uint8Array || i2 instanceof Float32Array) && i2.length !== o2) throw Error("Unsupported channel count: " + i2.length / o2);
  return t2 = new ya([i2], n2, false, t2.g.i.canvas, t2.O, s2, e2), r2 ? t2.clone() : t2;
}
var Ya = class extends $o {
  constructor(t2, e2, n2, r2) {
    super(t2), this.g = t2, this.aa = e2, this.T = n2, this.pa = r2, this.O = new sa();
  }
  l(t2, e2 = true) {
    if ("runningMode" in t2 && fn(this.baseOptions, 2, !!t2.runningMode && "IMAGE" !== t2.runningMode), void 0 !== t2.canvas && this.g.i.canvas !== t2.canvas) throw Error("You must create a new task to reset the canvas.");
    return super.l(t2, e2);
  }
  close() {
    this.O.close(), super.close();
  }
};
Ya.prototype.close = Ya.prototype.close;
var $a = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "image_in", "norm_rect_in", false), this.j = { detections: [] }, sn(t2 = this.h = new Is(), 0, 1, e2 = new Ls()), gn(this.h, 2, 0.5), gn(this.h, 3, 0.3);
  }
  get baseOptions() {
    return en(this.h, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.h, 0, 1, t2);
  }
  o(t2) {
    return "minDetectionConfidence" in t2 && gn(this.h, 2, t2.minDetectionConfidence ?? 0.5), "minSuppressionThreshold" in t2 && gn(this.h, 3, t2.minSuppressionThreshold ?? 0.3), this.l(t2);
  }
  D(t2, e2) {
    return this.j = { detections: [] }, Wa(this, t2, e2), this.j;
  }
  F(t2, e2, n2) {
    return this.j = { detections: [] }, za(this, t2, n2, e2), this.j;
  }
  m() {
    var t2 = new qi();
    Yi(t2, "image_in"), Yi(t2, "norm_rect_in"), $i(t2, "detections");
    const e2 = new Di();
    Xn(e2, Ps, this.h);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.face_detector.FaceDetectorGraph"), ji(n2, "IMAGE:image_in"), ji(n2, "NORM_RECT:norm_rect_in"), Vi(n2, "DETECTIONS:detections"), n2.o(e2), Ki(t2, n2), this.g.attachProtoVectorListener("detections", ((t3, e3) => {
      for (const e4 of t3) t3 = os(e4), this.j.detections.push(bo(t3));
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("detections", ((t3) => {
      Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
$a.prototype.detectForVideo = $a.prototype.F, $a.prototype.detect = $a.prototype.D, $a.prototype.setOptions = $a.prototype.o, $a.createFromModelPath = async function(t2, e2) {
  return Xa($a, t2, { baseOptions: { modelAssetPath: e2 } });
}, $a.createFromModelBuffer = function(t2, e2) {
  return Xa($a, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, $a.createFromOptions = function(t2, e2) {
  return Xa($a, t2, e2);
};
var qa = Ba([61, 146], [146, 91], [91, 181], [181, 84], [84, 17], [17, 314], [314, 405], [405, 321], [321, 375], [375, 291], [61, 185], [185, 40], [40, 39], [39, 37], [37, 0], [0, 267], [267, 269], [269, 270], [270, 409], [409, 291], [78, 95], [95, 88], [88, 178], [178, 87], [87, 14], [14, 317], [317, 402], [402, 318], [318, 324], [324, 308], [78, 191], [191, 80], [80, 81], [81, 82], [82, 13], [13, 312], [312, 311], [311, 310], [310, 415], [415, 308]);
var Ja = Ba([263, 249], [249, 390], [390, 373], [373, 374], [374, 380], [380, 381], [381, 382], [382, 362], [263, 466], [466, 388], [388, 387], [387, 386], [386, 385], [385, 384], [384, 398], [398, 362]);
var Za = Ba([276, 283], [283, 282], [282, 295], [295, 285], [300, 293], [293, 334], [334, 296], [296, 336]);
var Qa = Ba([474, 475], [475, 476], [476, 477], [477, 474]);
var tc = Ba([33, 7], [7, 163], [163, 144], [144, 145], [145, 153], [153, 154], [154, 155], [155, 133], [33, 246], [246, 161], [161, 160], [160, 159], [159, 158], [158, 157], [157, 173], [173, 133]);
var ec = Ba([46, 53], [53, 52], [52, 65], [65, 55], [70, 63], [63, 105], [105, 66], [66, 107]);
var nc = Ba([469, 470], [470, 471], [471, 472], [472, 469]);
var rc = Ba([10, 338], [338, 297], [297, 332], [332, 284], [284, 251], [251, 389], [389, 356], [356, 454], [454, 323], [323, 361], [361, 288], [288, 397], [397, 365], [365, 379], [379, 378], [378, 400], [400, 377], [377, 152], [152, 148], [148, 176], [176, 149], [149, 150], [150, 136], [136, 172], [172, 58], [58, 132], [132, 93], [93, 234], [234, 127], [127, 162], [162, 21], [21, 54], [54, 103], [103, 67], [67, 109], [109, 10]);
var ic = [...qa, ...Ja, ...Za, ...tc, ...ec, ...rc];
var sc = Ba([127, 34], [34, 139], [139, 127], [11, 0], [0, 37], [37, 11], [232, 231], [231, 120], [120, 232], [72, 37], [37, 39], [39, 72], [128, 121], [121, 47], [47, 128], [232, 121], [121, 128], [128, 232], [104, 69], [69, 67], [67, 104], [175, 171], [171, 148], [148, 175], [118, 50], [50, 101], [101, 118], [73, 39], [39, 40], [40, 73], [9, 151], [151, 108], [108, 9], [48, 115], [115, 131], [131, 48], [194, 204], [204, 211], [211, 194], [74, 40], [40, 185], [185, 74], [80, 42], [42, 183], [183, 80], [40, 92], [92, 186], [186, 40], [230, 229], [229, 118], [118, 230], [202, 212], [212, 214], [214, 202], [83, 18], [18, 17], [17, 83], [76, 61], [61, 146], [146, 76], [160, 29], [29, 30], [30, 160], [56, 157], [157, 173], [173, 56], [106, 204], [204, 194], [194, 106], [135, 214], [214, 192], [192, 135], [203, 165], [165, 98], [98, 203], [21, 71], [71, 68], [68, 21], [51, 45], [45, 4], [4, 51], [144, 24], [24, 23], [23, 144], [77, 146], [146, 91], [91, 77], [205, 50], [50, 187], [187, 205], [201, 200], [200, 18], [18, 201], [91, 106], [106, 182], [182, 91], [90, 91], [91, 181], [181, 90], [85, 84], [84, 17], [17, 85], [206, 203], [203, 36], [36, 206], [148, 171], [171, 140], [140, 148], [92, 40], [40, 39], [39, 92], [193, 189], [189, 244], [244, 193], [159, 158], [158, 28], [28, 159], [247, 246], [246, 161], [161, 247], [236, 3], [3, 196], [196, 236], [54, 68], [68, 104], [104, 54], [193, 168], [168, 8], [8, 193], [117, 228], [228, 31], [31, 117], [189, 193], [193, 55], [55, 189], [98, 97], [97, 99], [99, 98], [126, 47], [47, 100], [100, 126], [166, 79], [79, 218], [218, 166], [155, 154], [154, 26], [26, 155], [209, 49], [49, 131], [131, 209], [135, 136], [136, 150], [150, 135], [47, 126], [126, 217], [217, 47], [223, 52], [52, 53], [53, 223], [45, 51], [51, 134], [134, 45], [211, 170], [170, 140], [140, 211], [67, 69], [69, 108], [108, 67], [43, 106], [106, 91], [91, 43], [230, 119], [119, 120], [120, 230], [226, 130], [130, 247], [247, 226], [63, 53], [53, 52], [52, 63], [238, 20], [20, 242], [242, 238], [46, 70], [70, 156], [156, 46], [78, 62], [62, 96], [96, 78], [46, 53], [53, 63], [63, 46], [143, 34], [34, 227], [227, 143], [123, 117], [117, 111], [111, 123], [44, 125], [125, 19], [19, 44], [236, 134], [134, 51], [51, 236], [216, 206], [206, 205], [205, 216], [154, 153], [153, 22], [22, 154], [39, 37], [37, 167], [167, 39], [200, 201], [201, 208], [208, 200], [36, 142], [142, 100], [100, 36], [57, 212], [212, 202], [202, 57], [20, 60], [60, 99], [99, 20], [28, 158], [158, 157], [157, 28], [35, 226], [226, 113], [113, 35], [160, 159], [159, 27], [27, 160], [204, 202], [202, 210], [210, 204], [113, 225], [225, 46], [46, 113], [43, 202], [202, 204], [204, 43], [62, 76], [76, 77], [77, 62], [137, 123], [123, 116], [116, 137], [41, 38], [38, 72], [72, 41], [203, 129], [129, 142], [142, 203], [64, 98], [98, 240], [240, 64], [49, 102], [102, 64], [64, 49], [41, 73], [73, 74], [74, 41], [212, 216], [216, 207], [207, 212], [42, 74], [74, 184], [184, 42], [169, 170], [170, 211], [211, 169], [170, 149], [149, 176], [176, 170], [105, 66], [66, 69], [69, 105], [122, 6], [6, 168], [168, 122], [123, 147], [147, 187], [187, 123], [96, 77], [77, 90], [90, 96], [65, 55], [55, 107], [107, 65], [89, 90], [90, 180], [180, 89], [101, 100], [100, 120], [120, 101], [63, 105], [105, 104], [104, 63], [93, 137], [137, 227], [227, 93], [15, 86], [86, 85], [85, 15], [129, 102], [102, 49], [49, 129], [14, 87], [87, 86], [86, 14], [55, 8], [8, 9], [9, 55], [100, 47], [47, 121], [121, 100], [145, 23], [23, 22], [22, 145], [88, 89], [89, 179], [179, 88], [6, 122], [122, 196], [196, 6], [88, 95], [95, 96], [96, 88], [138, 172], [172, 136], [136, 138], [215, 58], [58, 172], [172, 215], [115, 48], [48, 219], [219, 115], [42, 80], [80, 81], [81, 42], [195, 3], [3, 51], [51, 195], [43, 146], [146, 61], [61, 43], [171, 175], [175, 199], [199, 171], [81, 82], [82, 38], [38, 81], [53, 46], [46, 225], [225, 53], [144, 163], [163, 110], [110, 144], [52, 65], [65, 66], [66, 52], [229, 228], [228, 117], [117, 229], [34, 127], [127, 234], [234, 34], [107, 108], [108, 69], [69, 107], [109, 108], [108, 151], [151, 109], [48, 64], [64, 235], [235, 48], [62, 78], [78, 191], [191, 62], [129, 209], [209, 126], [126, 129], [111, 35], [35, 143], [143, 111], [117, 123], [123, 50], [50, 117], [222, 65], [65, 52], [52, 222], [19, 125], [125, 141], [141, 19], [221, 55], [55, 65], [65, 221], [3, 195], [195, 197], [197, 3], [25, 7], [7, 33], [33, 25], [220, 237], [237, 44], [44, 220], [70, 71], [71, 139], [139, 70], [122, 193], [193, 245], [245, 122], [247, 130], [130, 33], [33, 247], [71, 21], [21, 162], [162, 71], [170, 169], [169, 150], [150, 170], [188, 174], [174, 196], [196, 188], [216, 186], [186, 92], [92, 216], [2, 97], [97, 167], [167, 2], [141, 125], [125, 241], [241, 141], [164, 167], [167, 37], [37, 164], [72, 38], [38, 12], [12, 72], [38, 82], [82, 13], [13, 38], [63, 68], [68, 71], [71, 63], [226, 35], [35, 111], [111, 226], [101, 50], [50, 205], [205, 101], [206, 92], [92, 165], [165, 206], [209, 198], [198, 217], [217, 209], [165, 167], [167, 97], [97, 165], [220, 115], [115, 218], [218, 220], [133, 112], [112, 243], [243, 133], [239, 238], [238, 241], [241, 239], [214, 135], [135, 169], [169, 214], [190, 173], [173, 133], [133, 190], [171, 208], [208, 32], [32, 171], [125, 44], [44, 237], [237, 125], [86, 87], [87, 178], [178, 86], [85, 86], [86, 179], [179, 85], [84, 85], [85, 180], [180, 84], [83, 84], [84, 181], [181, 83], [201, 83], [83, 182], [182, 201], [137, 93], [93, 132], [132, 137], [76, 62], [62, 183], [183, 76], [61, 76], [76, 184], [184, 61], [57, 61], [61, 185], [185, 57], [212, 57], [57, 186], [186, 212], [214, 207], [207, 187], [187, 214], [34, 143], [143, 156], [156, 34], [79, 239], [239, 237], [237, 79], [123, 137], [137, 177], [177, 123], [44, 1], [1, 4], [4, 44], [201, 194], [194, 32], [32, 201], [64, 102], [102, 129], [129, 64], [213, 215], [215, 138], [138, 213], [59, 166], [166, 219], [219, 59], [242, 99], [99, 97], [97, 242], [2, 94], [94, 141], [141, 2], [75, 59], [59, 235], [235, 75], [24, 110], [110, 228], [228, 24], [25, 130], [130, 226], [226, 25], [23, 24], [24, 229], [229, 23], [22, 23], [23, 230], [230, 22], [26, 22], [22, 231], [231, 26], [112, 26], [26, 232], [232, 112], [189, 190], [190, 243], [243, 189], [221, 56], [56, 190], [190, 221], [28, 56], [56, 221], [221, 28], [27, 28], [28, 222], [222, 27], [29, 27], [27, 223], [223, 29], [30, 29], [29, 224], [224, 30], [247, 30], [30, 225], [225, 247], [238, 79], [79, 20], [20, 238], [166, 59], [59, 75], [75, 166], [60, 75], [75, 240], [240, 60], [147, 177], [177, 215], [215, 147], [20, 79], [79, 166], [166, 20], [187, 147], [147, 213], [213, 187], [112, 233], [233, 244], [244, 112], [233, 128], [128, 245], [245, 233], [128, 114], [114, 188], [188, 128], [114, 217], [217, 174], [174, 114], [131, 115], [115, 220], [220, 131], [217, 198], [198, 236], [236, 217], [198, 131], [131, 134], [134, 198], [177, 132], [132, 58], [58, 177], [143, 35], [35, 124], [124, 143], [110, 163], [163, 7], [7, 110], [228, 110], [110, 25], [25, 228], [356, 389], [389, 368], [368, 356], [11, 302], [302, 267], [267, 11], [452, 350], [350, 349], [349, 452], [302, 303], [303, 269], [269, 302], [357, 343], [343, 277], [277, 357], [452, 453], [453, 357], [357, 452], [333, 332], [332, 297], [297, 333], [175, 152], [152, 377], [377, 175], [347, 348], [348, 330], [330, 347], [303, 304], [304, 270], [270, 303], [9, 336], [336, 337], [337, 9], [278, 279], [279, 360], [360, 278], [418, 262], [262, 431], [431, 418], [304, 408], [408, 409], [409, 304], [310, 415], [415, 407], [407, 310], [270, 409], [409, 410], [410, 270], [450, 348], [348, 347], [347, 450], [422, 430], [430, 434], [434, 422], [313, 314], [314, 17], [17, 313], [306, 307], [307, 375], [375, 306], [387, 388], [388, 260], [260, 387], [286, 414], [414, 398], [398, 286], [335, 406], [406, 418], [418, 335], [364, 367], [367, 416], [416, 364], [423, 358], [358, 327], [327, 423], [251, 284], [284, 298], [298, 251], [281, 5], [5, 4], [4, 281], [373, 374], [374, 253], [253, 373], [307, 320], [320, 321], [321, 307], [425, 427], [427, 411], [411, 425], [421, 313], [313, 18], [18, 421], [321, 405], [405, 406], [406, 321], [320, 404], [404, 405], [405, 320], [315, 16], [16, 17], [17, 315], [426, 425], [425, 266], [266, 426], [377, 400], [400, 369], [369, 377], [322, 391], [391, 269], [269, 322], [417, 465], [465, 464], [464, 417], [386, 257], [257, 258], [258, 386], [466, 260], [260, 388], [388, 466], [456, 399], [399, 419], [419, 456], [284, 332], [332, 333], [333, 284], [417, 285], [285, 8], [8, 417], [346, 340], [340, 261], [261, 346], [413, 441], [441, 285], [285, 413], [327, 460], [460, 328], [328, 327], [355, 371], [371, 329], [329, 355], [392, 439], [439, 438], [438, 392], [382, 341], [341, 256], [256, 382], [429, 420], [420, 360], [360, 429], [364, 394], [394, 379], [379, 364], [277, 343], [343, 437], [437, 277], [443, 444], [444, 283], [283, 443], [275, 440], [440, 363], [363, 275], [431, 262], [262, 369], [369, 431], [297, 338], [338, 337], [337, 297], [273, 375], [375, 321], [321, 273], [450, 451], [451, 349], [349, 450], [446, 342], [342, 467], [467, 446], [293, 334], [334, 282], [282, 293], [458, 461], [461, 462], [462, 458], [276, 353], [353, 383], [383, 276], [308, 324], [324, 325], [325, 308], [276, 300], [300, 293], [293, 276], [372, 345], [345, 447], [447, 372], [352, 345], [345, 340], [340, 352], [274, 1], [1, 19], [19, 274], [456, 248], [248, 281], [281, 456], [436, 427], [427, 425], [425, 436], [381, 256], [256, 252], [252, 381], [269, 391], [391, 393], [393, 269], [200, 199], [199, 428], [428, 200], [266, 330], [330, 329], [329, 266], [287, 273], [273, 422], [422, 287], [250, 462], [462, 328], [328, 250], [258, 286], [286, 384], [384, 258], [265, 353], [353, 342], [342, 265], [387, 259], [259, 257], [257, 387], [424, 431], [431, 430], [430, 424], [342, 353], [353, 276], [276, 342], [273, 335], [335, 424], [424, 273], [292, 325], [325, 307], [307, 292], [366, 447], [447, 345], [345, 366], [271, 303], [303, 302], [302, 271], [423, 266], [266, 371], [371, 423], [294, 455], [455, 460], [460, 294], [279, 278], [278, 294], [294, 279], [271, 272], [272, 304], [304, 271], [432, 434], [434, 427], [427, 432], [272, 407], [407, 408], [408, 272], [394, 430], [430, 431], [431, 394], [395, 369], [369, 400], [400, 395], [334, 333], [333, 299], [299, 334], [351, 417], [417, 168], [168, 351], [352, 280], [280, 411], [411, 352], [325, 319], [319, 320], [320, 325], [295, 296], [296, 336], [336, 295], [319, 403], [403, 404], [404, 319], [330, 348], [348, 349], [349, 330], [293, 298], [298, 333], [333, 293], [323, 454], [454, 447], [447, 323], [15, 16], [16, 315], [315, 15], [358, 429], [429, 279], [279, 358], [14, 15], [15, 316], [316, 14], [285, 336], [336, 9], [9, 285], [329, 349], [349, 350], [350, 329], [374, 380], [380, 252], [252, 374], [318, 402], [402, 403], [403, 318], [6, 197], [197, 419], [419, 6], [318, 319], [319, 325], [325, 318], [367, 364], [364, 365], [365, 367], [435, 367], [367, 397], [397, 435], [344, 438], [438, 439], [439, 344], [272, 271], [271, 311], [311, 272], [195, 5], [5, 281], [281, 195], [273, 287], [287, 291], [291, 273], [396, 428], [428, 199], [199, 396], [311, 271], [271, 268], [268, 311], [283, 444], [444, 445], [445, 283], [373, 254], [254, 339], [339, 373], [282, 334], [334, 296], [296, 282], [449, 347], [347, 346], [346, 449], [264, 447], [447, 454], [454, 264], [336, 296], [296, 299], [299, 336], [338, 10], [10, 151], [151, 338], [278, 439], [439, 455], [455, 278], [292, 407], [407, 415], [415, 292], [358, 371], [371, 355], [355, 358], [340, 345], [345, 372], [372, 340], [346, 347], [347, 280], [280, 346], [442, 443], [443, 282], [282, 442], [19, 94], [94, 370], [370, 19], [441, 442], [442, 295], [295, 441], [248, 419], [419, 197], [197, 248], [263, 255], [255, 359], [359, 263], [440, 275], [275, 274], [274, 440], [300, 383], [383, 368], [368, 300], [351, 412], [412, 465], [465, 351], [263, 467], [467, 466], [466, 263], [301, 368], [368, 389], [389, 301], [395, 378], [378, 379], [379, 395], [412, 351], [351, 419], [419, 412], [436, 426], [426, 322], [322, 436], [2, 164], [164, 393], [393, 2], [370, 462], [462, 461], [461, 370], [164, 0], [0, 267], [267, 164], [302, 11], [11, 12], [12, 302], [268, 12], [12, 13], [13, 268], [293, 300], [300, 301], [301, 293], [446, 261], [261, 340], [340, 446], [330, 266], [266, 425], [425, 330], [426, 423], [423, 391], [391, 426], [429, 355], [355, 437], [437, 429], [391, 327], [327, 326], [326, 391], [440, 457], [457, 438], [438, 440], [341, 382], [382, 362], [362, 341], [459, 457], [457, 461], [461, 459], [434, 430], [430, 394], [394, 434], [414, 463], [463, 362], [362, 414], [396, 369], [369, 262], [262, 396], [354, 461], [461, 457], [457, 354], [316, 403], [403, 402], [402, 316], [315, 404], [404, 403], [403, 315], [314, 405], [405, 404], [404, 314], [313, 406], [406, 405], [405, 313], [421, 418], [418, 406], [406, 421], [366, 401], [401, 361], [361, 366], [306, 408], [408, 407], [407, 306], [291, 409], [409, 408], [408, 291], [287, 410], [410, 409], [409, 287], [432, 436], [436, 410], [410, 432], [434, 416], [416, 411], [411, 434], [264, 368], [368, 383], [383, 264], [309, 438], [438, 457], [457, 309], [352, 376], [376, 401], [401, 352], [274, 275], [275, 4], [4, 274], [421, 428], [428, 262], [262, 421], [294, 327], [327, 358], [358, 294], [433, 416], [416, 367], [367, 433], [289, 455], [455, 439], [439, 289], [462, 370], [370, 326], [326, 462], [2, 326], [326, 370], [370, 2], [305, 460], [460, 455], [455, 305], [254, 449], [449, 448], [448, 254], [255, 261], [261, 446], [446, 255], [253, 450], [450, 449], [449, 253], [252, 451], [451, 450], [450, 252], [256, 452], [452, 451], [451, 256], [341, 453], [453, 452], [452, 341], [413, 464], [464, 463], [463, 413], [441, 413], [413, 414], [414, 441], [258, 442], [442, 441], [441, 258], [257, 443], [443, 442], [442, 257], [259, 444], [444, 443], [443, 259], [260, 445], [445, 444], [444, 260], [467, 342], [342, 445], [445, 467], [459, 458], [458, 250], [250, 459], [289, 392], [392, 290], [290, 289], [290, 328], [328, 460], [460, 290], [376, 433], [433, 435], [435, 376], [250, 290], [290, 392], [392, 250], [411, 416], [416, 433], [433, 411], [341, 463], [463, 464], [464, 341], [453, 464], [464, 465], [465, 453], [357, 465], [465, 412], [412, 357], [343, 412], [412, 399], [399, 343], [360, 363], [363, 440], [440, 360], [437, 399], [399, 456], [456, 437], [420, 456], [456, 363], [363, 420], [401, 435], [435, 288], [288, 401], [372, 383], [383, 353], [353, 372], [339, 255], [255, 249], [249, 339], [448, 261], [261, 255], [255, 448], [133, 243], [243, 190], [190, 133], [133, 155], [155, 112], [112, 133], [33, 246], [246, 247], [247, 33], [33, 130], [130, 25], [25, 33], [398, 384], [384, 286], [286, 398], [362, 398], [398, 414], [414, 362], [362, 463], [463, 341], [341, 362], [263, 359], [359, 467], [467, 263], [263, 249], [249, 255], [255, 263], [466, 467], [467, 260], [260, 466], [75, 60], [60, 166], [166, 75], [238, 239], [239, 79], [79, 238], [162, 127], [127, 139], [139, 162], [72, 11], [11, 37], [37, 72], [121, 232], [232, 120], [120, 121], [73, 72], [72, 39], [39, 73], [114, 128], [128, 47], [47, 114], [233, 232], [232, 128], [128, 233], [103, 104], [104, 67], [67, 103], [152, 175], [175, 148], [148, 152], [119, 118], [118, 101], [101, 119], [74, 73], [73, 40], [40, 74], [107, 9], [9, 108], [108, 107], [49, 48], [48, 131], [131, 49], [32, 194], [194, 211], [211, 32], [184, 74], [74, 185], [185, 184], [191, 80], [80, 183], [183, 191], [185, 40], [40, 186], [186, 185], [119, 230], [230, 118], [118, 119], [210, 202], [202, 214], [214, 210], [84, 83], [83, 17], [17, 84], [77, 76], [76, 146], [146, 77], [161, 160], [160, 30], [30, 161], [190, 56], [56, 173], [173, 190], [182, 106], [106, 194], [194, 182], [138, 135], [135, 192], [192, 138], [129, 203], [203, 98], [98, 129], [54, 21], [21, 68], [68, 54], [5, 51], [51, 4], [4, 5], [145, 144], [144, 23], [23, 145], [90, 77], [77, 91], [91, 90], [207, 205], [205, 187], [187, 207], [83, 201], [201, 18], [18, 83], [181, 91], [91, 182], [182, 181], [180, 90], [90, 181], [181, 180], [16, 85], [85, 17], [17, 16], [205, 206], [206, 36], [36, 205], [176, 148], [148, 140], [140, 176], [165, 92], [92, 39], [39, 165], [245, 193], [193, 244], [244, 245], [27, 159], [159, 28], [28, 27], [30, 247], [247, 161], [161, 30], [174, 236], [236, 196], [196, 174], [103, 54], [54, 104], [104, 103], [55, 193], [193, 8], [8, 55], [111, 117], [117, 31], [31, 111], [221, 189], [189, 55], [55, 221], [240, 98], [98, 99], [99, 240], [142, 126], [126, 100], [100, 142], [219, 166], [166, 218], [218, 219], [112, 155], [155, 26], [26, 112], [198, 209], [209, 131], [131, 198], [169, 135], [135, 150], [150, 169], [114, 47], [47, 217], [217, 114], [224, 223], [223, 53], [53, 224], [220, 45], [45, 134], [134, 220], [32, 211], [211, 140], [140, 32], [109, 67], [67, 108], [108, 109], [146, 43], [43, 91], [91, 146], [231, 230], [230, 120], [120, 231], [113, 226], [226, 247], [247, 113], [105, 63], [63, 52], [52, 105], [241, 238], [238, 242], [242, 241], [124, 46], [46, 156], [156, 124], [95, 78], [78, 96], [96, 95], [70, 46], [46, 63], [63, 70], [116, 143], [143, 227], [227, 116], [116, 123], [123, 111], [111, 116], [1, 44], [44, 19], [19, 1], [3, 236], [236, 51], [51, 3], [207, 216], [216, 205], [205, 207], [26, 154], [154, 22], [22, 26], [165, 39], [39, 167], [167, 165], [199, 200], [200, 208], [208, 199], [101, 36], [36, 100], [100, 101], [43, 57], [57, 202], [202, 43], [242, 20], [20, 99], [99, 242], [56, 28], [28, 157], [157, 56], [124, 35], [35, 113], [113, 124], [29, 160], [160, 27], [27, 29], [211, 204], [204, 210], [210, 211], [124, 113], [113, 46], [46, 124], [106, 43], [43, 204], [204, 106], [96, 62], [62, 77], [77, 96], [227, 137], [137, 116], [116, 227], [73, 41], [41, 72], [72, 73], [36, 203], [203, 142], [142, 36], [235, 64], [64, 240], [240, 235], [48, 49], [49, 64], [64, 48], [42, 41], [41, 74], [74, 42], [214, 212], [212, 207], [207, 214], [183, 42], [42, 184], [184, 183], [210, 169], [169, 211], [211, 210], [140, 170], [170, 176], [176, 140], [104, 105], [105, 69], [69, 104], [193, 122], [122, 168], [168, 193], [50, 123], [123, 187], [187, 50], [89, 96], [96, 90], [90, 89], [66, 65], [65, 107], [107, 66], [179, 89], [89, 180], [180, 179], [119, 101], [101, 120], [120, 119], [68, 63], [63, 104], [104, 68], [234, 93], [93, 227], [227, 234], [16, 15], [15, 85], [85, 16], [209, 129], [129, 49], [49, 209], [15, 14], [14, 86], [86, 15], [107, 55], [55, 9], [9, 107], [120, 100], [100, 121], [121, 120], [153, 145], [145, 22], [22, 153], [178, 88], [88, 179], [179, 178], [197, 6], [6, 196], [196, 197], [89, 88], [88, 96], [96, 89], [135, 138], [138, 136], [136, 135], [138, 215], [215, 172], [172, 138], [218, 115], [115, 219], [219, 218], [41, 42], [42, 81], [81, 41], [5, 195], [195, 51], [51, 5], [57, 43], [43, 61], [61, 57], [208, 171], [171, 199], [199, 208], [41, 81], [81, 38], [38, 41], [224, 53], [53, 225], [225, 224], [24, 144], [144, 110], [110, 24], [105, 52], [52, 66], [66, 105], [118, 229], [229, 117], [117, 118], [227, 34], [34, 234], [234, 227], [66, 107], [107, 69], [69, 66], [10, 109], [109, 151], [151, 10], [219, 48], [48, 235], [235, 219], [183, 62], [62, 191], [191, 183], [142, 129], [129, 126], [126, 142], [116, 111], [111, 143], [143, 116], [118, 117], [117, 50], [50, 118], [223, 222], [222, 52], [52, 223], [94, 19], [19, 141], [141, 94], [222, 221], [221, 65], [65, 222], [196, 3], [3, 197], [197, 196], [45, 220], [220, 44], [44, 45], [156, 70], [70, 139], [139, 156], [188, 122], [122, 245], [245, 188], [139, 71], [71, 162], [162, 139], [149, 170], [170, 150], [150, 149], [122, 188], [188, 196], [196, 122], [206, 216], [216, 92], [92, 206], [164, 2], [2, 167], [167, 164], [242, 141], [141, 241], [241, 242], [0, 164], [164, 37], [37, 0], [11, 72], [72, 12], [12, 11], [12, 38], [38, 13], [13, 12], [70, 63], [63, 71], [71, 70], [31, 226], [226, 111], [111, 31], [36, 101], [101, 205], [205, 36], [203, 206], [206, 165], [165, 203], [126, 209], [209, 217], [217, 126], [98, 165], [165, 97], [97, 98], [237, 220], [220, 218], [218, 237], [237, 239], [239, 241], [241, 237], [210, 214], [214, 169], [169, 210], [140, 171], [171, 32], [32, 140], [241, 125], [125, 237], [237, 241], [179, 86], [86, 178], [178, 179], [180, 85], [85, 179], [179, 180], [181, 84], [84, 180], [180, 181], [182, 83], [83, 181], [181, 182], [194, 201], [201, 182], [182, 194], [177, 137], [137, 132], [132, 177], [184, 76], [76, 183], [183, 184], [185, 61], [61, 184], [184, 185], [186, 57], [57, 185], [185, 186], [216, 212], [212, 186], [186, 216], [192, 214], [214, 187], [187, 192], [139, 34], [34, 156], [156, 139], [218, 79], [79, 237], [237, 218], [147, 123], [123, 177], [177, 147], [45, 44], [44, 4], [4, 45], [208, 201], [201, 32], [32, 208], [98, 64], [64, 129], [129, 98], [192, 213], [213, 138], [138, 192], [235, 59], [59, 219], [219, 235], [141, 242], [242, 97], [97, 141], [97, 2], [2, 141], [141, 97], [240, 75], [75, 235], [235, 240], [229, 24], [24, 228], [228, 229], [31, 25], [25, 226], [226, 31], [230, 23], [23, 229], [229, 230], [231, 22], [22, 230], [230, 231], [232, 26], [26, 231], [231, 232], [233, 112], [112, 232], [232, 233], [244, 189], [189, 243], [243, 244], [189, 221], [221, 190], [190, 189], [222, 28], [28, 221], [221, 222], [223, 27], [27, 222], [222, 223], [224, 29], [29, 223], [223, 224], [225, 30], [30, 224], [224, 225], [113, 247], [247, 225], [225, 113], [99, 60], [60, 240], [240, 99], [213, 147], [147, 215], [215, 213], [60, 20], [20, 166], [166, 60], [192, 187], [187, 213], [213, 192], [243, 112], [112, 244], [244, 243], [244, 233], [233, 245], [245, 244], [245, 128], [128, 188], [188, 245], [188, 114], [114, 174], [174, 188], [134, 131], [131, 220], [220, 134], [174, 217], [217, 236], [236, 174], [236, 198], [198, 134], [134, 236], [215, 177], [177, 58], [58, 215], [156, 143], [143, 124], [124, 156], [25, 110], [110, 7], [7, 25], [31, 228], [228, 25], [25, 31], [264, 356], [356, 368], [368, 264], [0, 11], [11, 267], [267, 0], [451, 452], [452, 349], [349, 451], [267, 302], [302, 269], [269, 267], [350, 357], [357, 277], [277, 350], [350, 452], [452, 357], [357, 350], [299, 333], [333, 297], [297, 299], [396, 175], [175, 377], [377, 396], [280, 347], [347, 330], [330, 280], [269, 303], [303, 270], [270, 269], [151, 9], [9, 337], [337, 151], [344, 278], [278, 360], [360, 344], [424, 418], [418, 431], [431, 424], [270, 304], [304, 409], [409, 270], [272, 310], [310, 407], [407, 272], [322, 270], [270, 410], [410, 322], [449, 450], [450, 347], [347, 449], [432, 422], [422, 434], [434, 432], [18, 313], [313, 17], [17, 18], [291, 306], [306, 375], [375, 291], [259, 387], [387, 260], [260, 259], [424, 335], [335, 418], [418, 424], [434, 364], [364, 416], [416, 434], [391, 423], [423, 327], [327, 391], [301, 251], [251, 298], [298, 301], [275, 281], [281, 4], [4, 275], [254, 373], [373, 253], [253, 254], [375, 307], [307, 321], [321, 375], [280, 425], [425, 411], [411, 280], [200, 421], [421, 18], [18, 200], [335, 321], [321, 406], [406, 335], [321, 320], [320, 405], [405, 321], [314, 315], [315, 17], [17, 314], [423, 426], [426, 266], [266, 423], [396, 377], [377, 369], [369, 396], [270, 322], [322, 269], [269, 270], [413, 417], [417, 464], [464, 413], [385, 386], [386, 258], [258, 385], [248, 456], [456, 419], [419, 248], [298, 284], [284, 333], [333, 298], [168, 417], [417, 8], [8, 168], [448, 346], [346, 261], [261, 448], [417, 413], [413, 285], [285, 417], [326, 327], [327, 328], [328, 326], [277, 355], [355, 329], [329, 277], [309, 392], [392, 438], [438, 309], [381, 382], [382, 256], [256, 381], [279, 429], [429, 360], [360, 279], [365, 364], [364, 379], [379, 365], [355, 277], [277, 437], [437, 355], [282, 443], [443, 283], [283, 282], [281, 275], [275, 363], [363, 281], [395, 431], [431, 369], [369, 395], [299, 297], [297, 337], [337, 299], [335, 273], [273, 321], [321, 335], [348, 450], [450, 349], [349, 348], [359, 446], [446, 467], [467, 359], [283, 293], [293, 282], [282, 283], [250, 458], [458, 462], [462, 250], [300, 276], [276, 383], [383, 300], [292, 308], [308, 325], [325, 292], [283, 276], [276, 293], [293, 283], [264, 372], [372, 447], [447, 264], [346, 352], [352, 340], [340, 346], [354, 274], [274, 19], [19, 354], [363, 456], [456, 281], [281, 363], [426, 436], [436, 425], [425, 426], [380, 381], [381, 252], [252, 380], [267, 269], [269, 393], [393, 267], [421, 200], [200, 428], [428, 421], [371, 266], [266, 329], [329, 371], [432, 287], [287, 422], [422, 432], [290, 250], [250, 328], [328, 290], [385, 258], [258, 384], [384, 385], [446, 265], [265, 342], [342, 446], [386, 387], [387, 257], [257, 386], [422, 424], [424, 430], [430, 422], [445, 342], [342, 276], [276, 445], [422, 273], [273, 424], [424, 422], [306, 292], [292, 307], [307, 306], [352, 366], [366, 345], [345, 352], [268, 271], [271, 302], [302, 268], [358, 423], [423, 371], [371, 358], [327, 294], [294, 460], [460, 327], [331, 279], [279, 294], [294, 331], [303, 271], [271, 304], [304, 303], [436, 432], [432, 427], [427, 436], [304, 272], [272, 408], [408, 304], [395, 394], [394, 431], [431, 395], [378, 395], [395, 400], [400, 378], [296, 334], [334, 299], [299, 296], [6, 351], [351, 168], [168, 6], [376, 352], [352, 411], [411, 376], [307, 325], [325, 320], [320, 307], [285, 295], [295, 336], [336, 285], [320, 319], [319, 404], [404, 320], [329, 330], [330, 349], [349, 329], [334, 293], [293, 333], [333, 334], [366, 323], [323, 447], [447, 366], [316, 15], [15, 315], [315, 316], [331, 358], [358, 279], [279, 331], [317, 14], [14, 316], [316, 317], [8, 285], [285, 9], [9, 8], [277, 329], [329, 350], [350, 277], [253, 374], [374, 252], [252, 253], [319, 318], [318, 403], [403, 319], [351, 6], [6, 419], [419, 351], [324, 318], [318, 325], [325, 324], [397, 367], [367, 365], [365, 397], [288, 435], [435, 397], [397, 288], [278, 344], [344, 439], [439, 278], [310, 272], [272, 311], [311, 310], [248, 195], [195, 281], [281, 248], [375, 273], [273, 291], [291, 375], [175, 396], [396, 199], [199, 175], [312, 311], [311, 268], [268, 312], [276, 283], [283, 445], [445, 276], [390, 373], [373, 339], [339, 390], [295, 282], [282, 296], [296, 295], [448, 449], [449, 346], [346, 448], [356, 264], [264, 454], [454, 356], [337, 336], [336, 299], [299, 337], [337, 338], [338, 151], [151, 337], [294, 278], [278, 455], [455, 294], [308, 292], [292, 415], [415, 308], [429, 358], [358, 355], [355, 429], [265, 340], [340, 372], [372, 265], [352, 346], [346, 280], [280, 352], [295, 442], [442, 282], [282, 295], [354, 19], [19, 370], [370, 354], [285, 441], [441, 295], [295, 285], [195, 248], [248, 197], [197, 195], [457, 440], [440, 274], [274, 457], [301, 300], [300, 368], [368, 301], [417, 351], [351, 465], [465, 417], [251, 301], [301, 389], [389, 251], [394, 395], [395, 379], [379, 394], [399, 412], [412, 419], [419, 399], [410, 436], [436, 322], [322, 410], [326, 2], [2, 393], [393, 326], [354, 370], [370, 461], [461, 354], [393, 164], [164, 267], [267, 393], [268, 302], [302, 12], [12, 268], [312, 268], [268, 13], [13, 312], [298, 293], [293, 301], [301, 298], [265, 446], [446, 340], [340, 265], [280, 330], [330, 425], [425, 280], [322, 426], [426, 391], [391, 322], [420, 429], [429, 437], [437, 420], [393, 391], [391, 326], [326, 393], [344, 440], [440, 438], [438, 344], [458, 459], [459, 461], [461, 458], [364, 434], [434, 394], [394, 364], [428, 396], [396, 262], [262, 428], [274, 354], [354, 457], [457, 274], [317, 316], [316, 402], [402, 317], [316, 315], [315, 403], [403, 316], [315, 314], [314, 404], [404, 315], [314, 313], [313, 405], [405, 314], [313, 421], [421, 406], [406, 313], [323, 366], [366, 361], [361, 323], [292, 306], [306, 407], [407, 292], [306, 291], [291, 408], [408, 306], [291, 287], [287, 409], [409, 291], [287, 432], [432, 410], [410, 287], [427, 434], [434, 411], [411, 427], [372, 264], [264, 383], [383, 372], [459, 309], [309, 457], [457, 459], [366, 352], [352, 401], [401, 366], [1, 274], [274, 4], [4, 1], [418, 421], [421, 262], [262, 418], [331, 294], [294, 358], [358, 331], [435, 433], [433, 367], [367, 435], [392, 289], [289, 439], [439, 392], [328, 462], [462, 326], [326, 328], [94, 2], [2, 370], [370, 94], [289, 305], [305, 455], [455, 289], [339, 254], [254, 448], [448, 339], [359, 255], [255, 446], [446, 359], [254, 253], [253, 449], [449, 254], [253, 252], [252, 450], [450, 253], [252, 256], [256, 451], [451, 252], [256, 341], [341, 452], [452, 256], [414, 413], [413, 463], [463, 414], [286, 441], [441, 414], [414, 286], [286, 258], [258, 441], [441, 286], [258, 257], [257, 442], [442, 258], [257, 259], [259, 443], [443, 257], [259, 260], [260, 444], [444, 259], [260, 467], [467, 445], [445, 260], [309, 459], [459, 250], [250, 309], [305, 289], [289, 290], [290, 305], [305, 290], [290, 460], [460, 305], [401, 376], [376, 435], [435, 401], [309, 250], [250, 392], [392, 309], [376, 411], [411, 433], [433, 376], [453, 341], [341, 464], [464, 453], [357, 453], [453, 465], [465, 357], [343, 357], [357, 412], [412, 343], [437, 343], [343, 399], [399, 437], [344, 360], [360, 440], [440, 344], [420, 437], [437, 456], [456, 420], [360, 420], [420, 363], [363, 360], [361, 401], [401, 288], [288, 361], [265, 372], [372, 353], [353, 265], [390, 339], [339, 249], [249, 390], [339, 448], [448, 255], [255, 339]);
function oc(t2) {
  t2.j = { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
}
var ac = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "image_in", "norm_rect", false), this.j = { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] }, this.outputFacialTransformationMatrixes = this.outputFaceBlendshapes = false, sn(t2 = this.h = new Us(), 0, 1, e2 = new Ls()), this.v = new Cs(), sn(this.h, 0, 3, this.v), this.s = new Is(), sn(this.h, 0, 2, this.s), pn(this.s, 4, 1), gn(this.s, 2, 0.5), gn(this.v, 2, 0.5), gn(this.h, 4, 0.5);
  }
  get baseOptions() {
    return en(this.h, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.h, 0, 1, t2);
  }
  o(t2) {
    return "numFaces" in t2 && pn(this.s, 4, t2.numFaces ?? 1), "minFaceDetectionConfidence" in t2 && gn(this.s, 2, t2.minFaceDetectionConfidence ?? 0.5), "minTrackingConfidence" in t2 && gn(this.h, 4, t2.minTrackingConfidence ?? 0.5), "minFacePresenceConfidence" in t2 && gn(this.v, 2, t2.minFacePresenceConfidence ?? 0.5), "outputFaceBlendshapes" in t2 && (this.outputFaceBlendshapes = !!t2.outputFaceBlendshapes), "outputFacialTransformationMatrixes" in t2 && (this.outputFacialTransformationMatrixes = !!t2.outputFacialTransformationMatrixes), this.l(t2);
  }
  D(t2, e2) {
    return oc(this), Wa(this, t2, e2), this.j;
  }
  F(t2, e2, n2) {
    return oc(this), za(this, t2, n2, e2), this.j;
  }
  m() {
    var t2 = new qi();
    Yi(t2, "image_in"), Yi(t2, "norm_rect"), $i(t2, "face_landmarks");
    const e2 = new Di();
    Xn(e2, Bs, this.h);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.face_landmarker.FaceLandmarkerGraph"), ji(n2, "IMAGE:image_in"), ji(n2, "NORM_RECT:norm_rect"), Vi(n2, "NORM_LANDMARKS:face_landmarks"), n2.o(e2), Ki(t2, n2), this.g.attachProtoVectorListener("face_landmarks", ((t3, e3) => {
      for (const e4 of t3) t3 = us(e4), this.j.faceLandmarks.push(ko(t3));
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("face_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.outputFaceBlendshapes && ($i(t2, "blendshapes"), Vi(n2, "BLENDSHAPES:blendshapes"), this.g.attachProtoVectorListener("blendshapes", ((t3, e3) => {
      if (this.outputFaceBlendshapes) for (const e4 of t3) t3 = ns(e4), this.j.faceBlendshapes.push(Ao(t3.g() ?? []));
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("blendshapes", ((t3) => {
      Wo(this, t3);
    }))), this.outputFacialTransformationMatrixes && ($i(t2, "face_geometry"), Vi(n2, "FACE_GEOMETRY:face_geometry"), this.g.attachProtoVectorListener("face_geometry", ((t3, e3) => {
      if (this.outputFacialTransformationMatrixes) for (const e4 of t3) (t3 = en(Os(e4), ls, 2)) && this.j.facialTransformationMatrixes.push({ rows: un(t3, 1) ?? 0 ?? 0, columns: un(t3, 2) ?? 0 ?? 0, data: Ve(t3, 3, $t, je()).slice() ?? [] });
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("face_geometry", ((t3) => {
      Wo(this, t3);
    }))), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
ac.prototype.detectForVideo = ac.prototype.F, ac.prototype.detect = ac.prototype.D, ac.prototype.setOptions = ac.prototype.o, ac.createFromModelPath = function(t2, e2) {
  return Xa(ac, t2, { baseOptions: { modelAssetPath: e2 } });
}, ac.createFromModelBuffer = function(t2, e2) {
  return Xa(ac, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, ac.createFromOptions = function(t2, e2) {
  return Xa(ac, t2, e2);
}, ac.FACE_LANDMARKS_LIPS = qa, ac.FACE_LANDMARKS_LEFT_EYE = Ja, ac.FACE_LANDMARKS_LEFT_EYEBROW = Za, ac.FACE_LANDMARKS_LEFT_IRIS = Qa, ac.FACE_LANDMARKS_RIGHT_EYE = tc, ac.FACE_LANDMARKS_RIGHT_EYEBROW = ec, ac.FACE_LANDMARKS_RIGHT_IRIS = nc, ac.FACE_LANDMARKS_FACE_OVAL = rc, ac.FACE_LANDMARKS_CONTOURS = ic, ac.FACE_LANDMARKS_TESSELATION = sc;
var cc = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "image_in", "norm_rect", true), sn(t2 = this.j = new Gs(), 0, 1, e2 = new Ls());
  }
  get baseOptions() {
    return en(this.j, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.j, 0, 1, t2);
  }
  o(t2) {
    return super.l(t2);
  }
  Oa(t2, e2, n2) {
    const r2 = "function" != typeof e2 ? e2 : {};
    if (this.h = "function" == typeof e2 ? e2 : n2, Wa(this, t2, r2 ?? {}), !this.h) return this.s;
  }
  m() {
    var t2 = new qi();
    Yi(t2, "image_in"), Yi(t2, "norm_rect"), $i(t2, "stylized_image");
    const e2 = new Di();
    Xn(e2, js, this.j);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.face_stylizer.FaceStylizerGraph"), ji(n2, "IMAGE:image_in"), ji(n2, "NORM_RECT:norm_rect"), Vi(n2, "STYLIZED_IMAGE:stylized_image"), n2.o(e2), Ki(t2, n2), this.g.U("stylized_image", ((t3, e3) => {
      var n3 = !this.h, r2 = t3.data, i2 = t3.width;
      const s2 = i2 * (t3 = t3.height);
      if (r2 instanceof Uint8Array) if (r2.length === 3 * s2) {
        const e4 = new Uint8ClampedArray(4 * s2);
        for (let t4 = 0; t4 < s2; ++t4) e4[4 * t4] = r2[3 * t4], e4[4 * t4 + 1] = r2[3 * t4 + 1], e4[4 * t4 + 2] = r2[3 * t4 + 2], e4[4 * t4 + 3] = 255;
        r2 = new ImageData(e4, i2, t3);
      } else {
        if (r2.length !== 4 * s2) throw Error("Unsupported channel count: " + r2.length / s2);
        r2 = new ImageData(new Uint8ClampedArray(r2.buffer, r2.byteOffset, r2.length), i2, t3);
      }
      else if (!(r2 instanceof WebGLTexture)) throw Error(`Unsupported format: ${r2.constructor.name}`);
      i2 = new Da([r2], false, false, this.g.i.canvas, this.O, i2, t3), this.s = n3 = n3 ? i2.clone() : i2, this.h && this.h(n3), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("stylized_image", ((t3) => {
      this.s = null, this.h && this.h(null), Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
cc.prototype.stylize = cc.prototype.Oa, cc.prototype.setOptions = cc.prototype.o, cc.createFromModelPath = function(t2, e2) {
  return Xa(cc, t2, { baseOptions: { modelAssetPath: e2 } });
}, cc.createFromModelBuffer = function(t2, e2) {
  return Xa(cc, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, cc.createFromOptions = function(t2, e2) {
  return Xa(cc, t2, e2);
};
var hc = Ba([0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]);
function uc(t2) {
  t2.gestures = [], t2.landmarks = [], t2.worldLandmarks = [], t2.handedness = [];
}
function lc(t2) {
  return 0 === t2.gestures.length ? { gestures: [], landmarks: [], worldLandmarks: [], handedness: [], handednesses: [] } : { gestures: t2.gestures, landmarks: t2.landmarks, worldLandmarks: t2.worldLandmarks, handedness: t2.handedness, handednesses: t2.handedness };
}
function dc(t2, e2 = true) {
  const n2 = [];
  for (const i2 of t2) {
    var r2 = ns(i2);
    t2 = [];
    for (const n3 of r2.g()) r2 = e2 && null != un(n3, 1) ? un(n3, 1) ?? 0 : -1, t2.push({ score: dn(n3, 2) ?? 0, index: r2, categoryName: ln(n3, 3) ?? "" ?? "", displayName: ln(n3, 4) ?? "" ?? "" });
    n2.push(t2);
  }
  return n2;
}
var fc = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "image_in", "norm_rect", false), this.gestures = [], this.landmarks = [], this.worldLandmarks = [], this.handedness = [], sn(t2 = this.j = new Ys(), 0, 1, e2 = new Ls()), this.s = new Ks(), sn(this.j, 0, 2, this.s), this.C = new zs(), sn(this.s, 0, 3, this.C), this.v = new Ws(), sn(this.s, 0, 2, this.v), this.h = new Hs(), sn(this.j, 0, 3, this.h), gn(this.v, 2, 0.5), gn(this.s, 4, 0.5), gn(this.C, 2, 0.5);
  }
  get baseOptions() {
    return en(this.j, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.j, 0, 1, t2);
  }
  o(t2) {
    if (pn(this.v, 3, t2.numHands ?? 1), "minHandDetectionConfidence" in t2 && gn(this.v, 2, t2.minHandDetectionConfidence ?? 0.5), "minTrackingConfidence" in t2 && gn(this.s, 4, t2.minTrackingConfidence ?? 0.5), "minHandPresenceConfidence" in t2 && gn(this.C, 2, t2.minHandPresenceConfidence ?? 0.5), t2.cannedGesturesClassifierOptions) {
      var e2 = new Vs(), n2 = e2, r2 = To(t2.cannedGesturesClassifierOptions, en(this.h, Vs, 3)?.h());
      sn(n2, 0, 2, r2), sn(this.h, 0, 3, e2);
    } else void 0 === t2.cannedGesturesClassifierOptions && en(this.h, Vs, 3)?.g();
    return t2.customGesturesClassifierOptions ? (sn(n2 = e2 = new Vs(), 0, 2, r2 = To(t2.customGesturesClassifierOptions, en(this.h, Vs, 4)?.h())), sn(this.h, 0, 4, e2)) : void 0 === t2.customGesturesClassifierOptions && en(this.h, Vs, 4)?.g(), this.l(t2);
  }
  Ja(t2, e2) {
    return uc(this), Wa(this, t2, e2), lc(this);
  }
  Ka(t2, e2, n2) {
    return uc(this), za(this, t2, n2, e2), lc(this);
  }
  m() {
    var t2 = new qi();
    Yi(t2, "image_in"), Yi(t2, "norm_rect"), $i(t2, "hand_gestures"), $i(t2, "hand_landmarks"), $i(t2, "world_hand_landmarks"), $i(t2, "handedness");
    const e2 = new Di();
    Xn(e2, Qs, this.j);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.gesture_recognizer.GestureRecognizerGraph"), ji(n2, "IMAGE:image_in"), ji(n2, "NORM_RECT:norm_rect"), Vi(n2, "HAND_GESTURES:hand_gestures"), Vi(n2, "LANDMARKS:hand_landmarks"), Vi(n2, "WORLD_LANDMARKS:world_hand_landmarks"), Vi(n2, "HANDEDNESS:handedness"), n2.o(e2), Ki(t2, n2), this.g.attachProtoVectorListener("hand_landmarks", ((t3, e3) => {
      for (const e4 of t3) {
        t3 = us(e4);
        const n3 = [];
        for (const e5 of rn(t3, hs, 1)) n3.push({ x: dn(e5, 1) ?? 0, y: dn(e5, 2) ?? 0, z: dn(e5, 3) ?? 0, visibility: dn(e5, 4) ?? 0 });
        this.landmarks.push(n3);
      }
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("hand_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.g.attachProtoVectorListener("world_hand_landmarks", ((t3, e3) => {
      for (const e4 of t3) {
        t3 = cs(e4);
        const n3 = [];
        for (const e5 of rn(t3, as, 1)) n3.push({ x: dn(e5, 1) ?? 0, y: dn(e5, 2) ?? 0, z: dn(e5, 3) ?? 0, visibility: dn(e5, 4) ?? 0 });
        this.worldLandmarks.push(n3);
      }
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("world_hand_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.g.attachProtoVectorListener("hand_gestures", ((t3, e3) => {
      this.gestures.push(...dc(t3, false)), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("hand_gestures", ((t3) => {
      Wo(this, t3);
    })), this.g.attachProtoVectorListener("handedness", ((t3, e3) => {
      this.handedness.push(...dc(t3)), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("handedness", ((t3) => {
      Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
function pc(t2) {
  return { landmarks: t2.landmarks, worldLandmarks: t2.worldLandmarks, handednesses: t2.handedness, handedness: t2.handedness };
}
fc.prototype.recognizeForVideo = fc.prototype.Ka, fc.prototype.recognize = fc.prototype.Ja, fc.prototype.setOptions = fc.prototype.o, fc.createFromModelPath = function(t2, e2) {
  return Xa(fc, t2, { baseOptions: { modelAssetPath: e2 } });
}, fc.createFromModelBuffer = function(t2, e2) {
  return Xa(fc, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, fc.createFromOptions = function(t2, e2) {
  return Xa(fc, t2, e2);
}, fc.HAND_CONNECTIONS = hc;
var gc = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "image_in", "norm_rect", false), this.landmarks = [], this.worldLandmarks = [], this.handedness = [], sn(t2 = this.h = new Ks(), 0, 1, e2 = new Ls()), this.s = new zs(), sn(this.h, 0, 3, this.s), this.j = new Ws(), sn(this.h, 0, 2, this.j), pn(this.j, 3, 1), gn(this.j, 2, 0.5), gn(this.s, 2, 0.5), gn(this.h, 4, 0.5);
  }
  get baseOptions() {
    return en(this.h, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.h, 0, 1, t2);
  }
  o(t2) {
    return "numHands" in t2 && pn(this.j, 3, t2.numHands ?? 1), "minHandDetectionConfidence" in t2 && gn(this.j, 2, t2.minHandDetectionConfidence ?? 0.5), "minTrackingConfidence" in t2 && gn(this.h, 4, t2.minTrackingConfidence ?? 0.5), "minHandPresenceConfidence" in t2 && gn(this.s, 2, t2.minHandPresenceConfidence ?? 0.5), this.l(t2);
  }
  D(t2, e2) {
    return this.landmarks = [], this.worldLandmarks = [], this.handedness = [], Wa(this, t2, e2), pc(this);
  }
  F(t2, e2, n2) {
    return this.landmarks = [], this.worldLandmarks = [], this.handedness = [], za(this, t2, n2, e2), pc(this);
  }
  m() {
    var t2 = new qi();
    Yi(t2, "image_in"), Yi(t2, "norm_rect"), $i(t2, "hand_landmarks"), $i(t2, "world_hand_landmarks"), $i(t2, "handedness");
    const e2 = new Di();
    Xn(e2, to, this.h);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.hand_landmarker.HandLandmarkerGraph"), ji(n2, "IMAGE:image_in"), ji(n2, "NORM_RECT:norm_rect"), Vi(n2, "LANDMARKS:hand_landmarks"), Vi(n2, "WORLD_LANDMARKS:world_hand_landmarks"), Vi(n2, "HANDEDNESS:handedness"), n2.o(e2), Ki(t2, n2), this.g.attachProtoVectorListener("hand_landmarks", ((t3, e3) => {
      for (const e4 of t3) t3 = us(e4), this.landmarks.push(ko(t3));
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("hand_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.g.attachProtoVectorListener("world_hand_landmarks", ((t3, e3) => {
      for (const e4 of t3) t3 = cs(e4), this.worldLandmarks.push(So(t3));
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("world_hand_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.g.attachProtoVectorListener("handedness", ((t3, e3) => {
      var n3 = this.handedness, r2 = n3.push;
      const i2 = [];
      for (const e4 of t3) {
        t3 = ns(e4);
        const n4 = [];
        for (const e5 of t3.g()) n4.push({ score: dn(e5, 2) ?? 0, index: un(e5, 1) ?? 0 ?? -1, categoryName: ln(e5, 3) ?? "" ?? "", displayName: ln(e5, 4) ?? "" ?? "" });
        i2.push(n4);
      }
      r2.call(n3, ...i2), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("handedness", ((t3) => {
      Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
gc.prototype.detectForVideo = gc.prototype.F, gc.prototype.detect = gc.prototype.D, gc.prototype.setOptions = gc.prototype.o, gc.createFromModelPath = function(t2, e2) {
  return Xa(gc, t2, { baseOptions: { modelAssetPath: e2 } });
}, gc.createFromModelBuffer = function(t2, e2) {
  return Xa(gc, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, gc.createFromOptions = function(t2, e2) {
  return Xa(gc, t2, e2);
}, gc.HAND_CONNECTIONS = hc;
var mc = Ba([0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10], [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19], [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32]);
function yc(t2) {
  t2.h = { faceLandmarks: [], faceBlendshapes: [], poseLandmarks: [], poseWorldLandmarks: [], poseSegmentationMasks: [], leftHandLandmarks: [], leftHandWorldLandmarks: [], rightHandLandmarks: [], rightHandWorldLandmarks: [] };
}
function _c(t2) {
  try {
    if (!t2.C) return t2.h;
    t2.C(t2.h);
  } finally {
    Yo(t2);
  }
}
function vc(t2, e2) {
  t2 = us(t2), e2.push(ko(t2));
}
var Ec = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "input_frames_image", null, false), this.h = { faceLandmarks: [], faceBlendshapes: [], poseLandmarks: [], poseWorldLandmarks: [], poseSegmentationMasks: [], leftHandLandmarks: [], leftHandWorldLandmarks: [], rightHandLandmarks: [], rightHandWorldLandmarks: [] }, this.outputPoseSegmentationMasks = this.outputFaceBlendshapes = false, sn(t2 = this.j = new io(), 0, 1, e2 = new Ls()), this.J = new zs(), sn(this.j, 0, 2, this.J), this.Z = new eo(), sn(this.j, 0, 3, this.Z), this.s = new Is(), sn(this.j, 0, 4, this.s), this.H = new Cs(), sn(this.j, 0, 5, this.H), this.v = new no(), sn(this.j, 0, 6, this.v), this.K = new ro(), sn(this.j, 0, 7, this.K), gn(this.s, 2, 0.5), gn(this.s, 3, 0.3), gn(this.H, 2, 0.5), gn(this.v, 2, 0.5), gn(this.v, 3, 0.3), gn(this.K, 2, 0.5), gn(this.J, 2, 0.5);
  }
  get baseOptions() {
    return en(this.j, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.j, 0, 1, t2);
  }
  o(t2) {
    return "minFaceDetectionConfidence" in t2 && gn(this.s, 2, t2.minFaceDetectionConfidence ?? 0.5), "minFaceSuppressionThreshold" in t2 && gn(this.s, 3, t2.minFaceSuppressionThreshold ?? 0.3), "minFacePresenceConfidence" in t2 && gn(this.H, 2, t2.minFacePresenceConfidence ?? 0.5), "outputFaceBlendshapes" in t2 && (this.outputFaceBlendshapes = !!t2.outputFaceBlendshapes), "minPoseDetectionConfidence" in t2 && gn(this.v, 2, t2.minPoseDetectionConfidence ?? 0.5), "minPoseSuppressionThreshold" in t2 && gn(this.v, 3, t2.minPoseSuppressionThreshold ?? 0.3), "minPosePresenceConfidence" in t2 && gn(this.K, 2, t2.minPosePresenceConfidence ?? 0.5), "outputPoseSegmentationMasks" in t2 && (this.outputPoseSegmentationMasks = !!t2.outputPoseSegmentationMasks), "minHandLandmarksConfidence" in t2 && gn(this.J, 2, t2.minHandLandmarksConfidence ?? 0.5), this.l(t2);
  }
  D(t2, e2, n2) {
    const r2 = "function" != typeof e2 ? e2 : {};
    return this.C = "function" == typeof e2 ? e2 : n2, yc(this), Wa(this, t2, r2), _c(this);
  }
  F(t2, e2, n2, r2) {
    const i2 = "function" != typeof n2 ? n2 : {};
    return this.C = "function" == typeof n2 ? n2 : r2, yc(this), za(this, t2, i2, e2), _c(this);
  }
  m() {
    var t2 = new qi();
    Yi(t2, "input_frames_image"), $i(t2, "pose_landmarks"), $i(t2, "pose_world_landmarks"), $i(t2, "face_landmarks"), $i(t2, "left_hand_landmarks"), $i(t2, "left_hand_world_landmarks"), $i(t2, "right_hand_landmarks"), $i(t2, "right_hand_world_landmarks");
    const e2 = new Di(), n2 = new bi();
    Ke(n2, 1, ae("type.googleapis.com/mediapipe.tasks.vision.holistic_landmarker.proto.HolisticLandmarkerGraphOptions"), ""), (function(t3, e3) {
      if (null != e3) if (Array.isArray(e3)) De(t3, 2, Re(e3));
      else {
        if (!("string" == typeof e3 || e3 instanceof N || O(e3))) throw Error("invalid value in Any.value field: " + e3 + " expected a ByteString, a base64 encoded string, a Uint8Array or a jspb array");
        Ke(t3, 2, ft(e3, false), U());
      }
    })(n2, this.j.g());
    const r2 = new Xi();
    Gi(r2, "mediapipe.tasks.vision.holistic_landmarker.HolisticLandmarkerGraph"), hn(r2, 8, bi, n2), ji(r2, "IMAGE:input_frames_image"), Vi(r2, "POSE_LANDMARKS:pose_landmarks"), Vi(r2, "POSE_WORLD_LANDMARKS:pose_world_landmarks"), Vi(r2, "FACE_LANDMARKS:face_landmarks"), Vi(r2, "LEFT_HAND_LANDMARKS:left_hand_landmarks"), Vi(r2, "LEFT_HAND_WORLD_LANDMARKS:left_hand_world_landmarks"), Vi(r2, "RIGHT_HAND_LANDMARKS:right_hand_landmarks"), Vi(r2, "RIGHT_HAND_WORLD_LANDMARKS:right_hand_world_landmarks"), r2.o(e2), Ki(t2, r2), zo(this, t2), this.g.attachProtoListener("pose_landmarks", ((t3, e3) => {
      vc(t3, this.h.poseLandmarks), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("pose_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.g.attachProtoListener("pose_world_landmarks", ((t3, e3) => {
      var n3 = this.h.poseWorldLandmarks;
      t3 = cs(t3), n3.push(So(t3)), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("pose_world_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.outputPoseSegmentationMasks && (Vi(r2, "POSE_SEGMENTATION_MASK:pose_segmentation_mask"), Ko(this, "pose_segmentation_mask"), this.g.U("pose_segmentation_mask", ((t3, e3) => {
      this.h.poseSegmentationMasks = [Ka(this, t3, true, !this.C)], Wo(this, e3);
    })), this.g.attachEmptyPacketListener("pose_segmentation_mask", ((t3) => {
      this.h.poseSegmentationMasks = [], Wo(this, t3);
    }))), this.g.attachProtoListener("face_landmarks", ((t3, e3) => {
      vc(t3, this.h.faceLandmarks), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("face_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.outputFaceBlendshapes && ($i(t2, "extra_blendshapes"), Vi(r2, "FACE_BLENDSHAPES:extra_blendshapes"), this.g.attachProtoListener("extra_blendshapes", ((t3, e3) => {
      var n3 = this.h.faceBlendshapes;
      this.outputFaceBlendshapes && (t3 = ns(t3), n3.push(Ao(t3.g() ?? []))), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("extra_blendshapes", ((t3) => {
      Wo(this, t3);
    }))), this.g.attachProtoListener("left_hand_landmarks", ((t3, e3) => {
      vc(t3, this.h.leftHandLandmarks), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("left_hand_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.g.attachProtoListener("left_hand_world_landmarks", ((t3, e3) => {
      var n3 = this.h.leftHandWorldLandmarks;
      t3 = cs(t3), n3.push(So(t3)), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("left_hand_world_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.g.attachProtoListener("right_hand_landmarks", ((t3, e3) => {
      vc(t3, this.h.rightHandLandmarks), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("right_hand_landmarks", ((t3) => {
      Wo(this, t3);
    })), this.g.attachProtoListener("right_hand_world_landmarks", ((t3, e3) => {
      var n3 = this.h.rightHandWorldLandmarks;
      t3 = cs(t3), n3.push(So(t3)), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("right_hand_world_landmarks", ((t3) => {
      Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
Ec.prototype.detectForVideo = Ec.prototype.F, Ec.prototype.detect = Ec.prototype.D, Ec.prototype.setOptions = Ec.prototype.o, Ec.createFromModelPath = function(t2, e2) {
  return Xa(Ec, t2, { baseOptions: { modelAssetPath: e2 } });
}, Ec.createFromModelBuffer = function(t2, e2) {
  return Xa(Ec, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, Ec.createFromOptions = function(t2, e2) {
  return Xa(Ec, t2, e2);
}, Ec.HAND_CONNECTIONS = hc, Ec.POSE_CONNECTIONS = mc, Ec.FACE_LANDMARKS_LIPS = qa, Ec.FACE_LANDMARKS_LEFT_EYE = Ja, Ec.FACE_LANDMARKS_LEFT_EYEBROW = Za, Ec.FACE_LANDMARKS_LEFT_IRIS = Qa, Ec.FACE_LANDMARKS_RIGHT_EYE = tc, Ec.FACE_LANDMARKS_RIGHT_EYEBROW = ec, Ec.FACE_LANDMARKS_RIGHT_IRIS = nc, Ec.FACE_LANDMARKS_FACE_OVAL = rc, Ec.FACE_LANDMARKS_CONTOURS = ic, Ec.FACE_LANDMARKS_TESSELATION = sc;
var wc = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "input_image", "norm_rect", true), this.j = { classifications: [] }, sn(t2 = this.h = new ao(), 0, 1, e2 = new Ls());
  }
  get baseOptions() {
    return en(this.h, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.h, 0, 1, t2);
  }
  o(t2) {
    return sn(this.h, 0, 2, To(t2, en(this.h, ws, 2))), this.l(t2);
  }
  sa(t2, e2) {
    return this.j = { classifications: [] }, Wa(this, t2, e2), this.j;
  }
  ta(t2, e2, n2) {
    return this.j = { classifications: [] }, za(this, t2, n2, e2), this.j;
  }
  m() {
    var t2 = new qi();
    Yi(t2, "input_image"), Yi(t2, "norm_rect"), $i(t2, "classifications");
    const e2 = new Di();
    Xn(e2, co, this.h);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.image_classifier.ImageClassifierGraph"), ji(n2, "IMAGE:input_image"), ji(n2, "NORM_RECT:norm_rect"), Vi(n2, "CLASSIFICATIONS:classifications"), n2.o(e2), Ki(t2, n2), this.g.attachProtoListener("classifications", ((t3, e3) => {
      this.j = (function(t4) {
        const e4 = { classifications: rn(t4, ps, 1).map(((t5) => Ao(en(t5, ts, 4)?.g() ?? [], un(t5, 2) ?? 0, ln(t5, 3) ?? ""))) };
        return null != ie(Ce(t4, 2)) && (e4.timestampMs = ie(Ce(t4, 2)) ?? 0), e4;
      })(gs(t3)), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("classifications", ((t3) => {
      Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
wc.prototype.classifyForVideo = wc.prototype.ta, wc.prototype.classify = wc.prototype.sa, wc.prototype.setOptions = wc.prototype.o, wc.createFromModelPath = function(t2, e2) {
  return Xa(wc, t2, { baseOptions: { modelAssetPath: e2 } });
}, wc.createFromModelBuffer = function(t2, e2) {
  return Xa(wc, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, wc.createFromOptions = function(t2, e2) {
  return Xa(wc, t2, e2);
};
var Tc = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "image_in", "norm_rect", true), this.h = new ho(), this.embeddings = { embeddings: [] }, sn(t2 = this.h, 0, 1, e2 = new Ls());
  }
  get baseOptions() {
    return en(this.h, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.h, 0, 1, t2);
  }
  o(t2) {
    var e2 = this.h, n2 = en(this.h, As, 2);
    return n2 = n2 ? n2.clone() : new As(), void 0 !== t2.l2Normalize ? fn(n2, 1, t2.l2Normalize) : "l2Normalize" in t2 && De(n2, 1), void 0 !== t2.quantize ? fn(n2, 2, t2.quantize) : "quantize" in t2 && De(n2, 2), sn(e2, 0, 2, n2), this.l(t2);
  }
  za(t2, e2) {
    return Wa(this, t2, e2), this.embeddings;
  }
  Aa(t2, e2, n2) {
    return za(this, t2, n2, e2), this.embeddings;
  }
  m() {
    var t2 = new qi();
    Yi(t2, "image_in"), Yi(t2, "norm_rect"), $i(t2, "embeddings_out");
    const e2 = new Di();
    Xn(e2, uo, this.h);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.image_embedder.ImageEmbedderGraph"), ji(n2, "IMAGE:image_in"), ji(n2, "NORM_RECT:norm_rect"), Vi(n2, "EMBEDDINGS:embeddings_out"), n2.o(e2), Ki(t2, n2), this.g.attachProtoListener("embeddings_out", ((t3, e3) => {
      t3 = Es(t3), this.embeddings = (function(t4) {
        return { embeddings: rn(t4, _s, 1).map(((t5) => {
          const e4 = { headIndex: un(t5, 3) ?? 0 ?? -1, headName: ln(t5, 4) ?? "" ?? "" };
          if (void 0 !== tn(t5, ms, $e(t5, 1))) t5 = Ve(t5 = en(t5, ms, $e(t5, 1)), 1, $t, je()), e4.floatEmbedding = t5.slice();
          else {
            const n3 = new Uint8Array(0);
            e4.quantizedEmbedding = en(t5, ys, $e(t5, 2))?.oa()?.h() ?? n3;
          }
          return e4;
        })), timestampMs: ie(Ce(t4, 2)) ?? 0 };
      })(t3), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("embeddings_out", ((t3) => {
      Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
Tc.cosineSimilarity = function(t2, e2) {
  if (t2.floatEmbedding && e2.floatEmbedding) t2 = Lo(t2.floatEmbedding, e2.floatEmbedding);
  else {
    if (!t2.quantizedEmbedding || !e2.quantizedEmbedding) throw Error("Cannot compute cosine similarity between quantized and float embeddings.");
    t2 = Lo(xo(t2.quantizedEmbedding), xo(e2.quantizedEmbedding));
  }
  return t2;
}, Tc.prototype.embedForVideo = Tc.prototype.Aa, Tc.prototype.embed = Tc.prototype.za, Tc.prototype.setOptions = Tc.prototype.o, Tc.createFromModelPath = function(t2, e2) {
  return Xa(Tc, t2, { baseOptions: { modelAssetPath: e2 } });
}, Tc.createFromModelBuffer = function(t2, e2) {
  return Xa(Tc, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, Tc.createFromOptions = function(t2, e2) {
  return Xa(Tc, t2, e2);
};
var Ac = class {
  constructor(t2, e2, n2) {
    this.confidenceMasks = t2, this.categoryMask = e2, this.qualityScores = n2;
  }
  close() {
    this.confidenceMasks?.forEach(((t2) => {
      t2.close();
    })), this.categoryMask?.close();
  }
};
function bc(t2) {
  t2.categoryMask = void 0, t2.confidenceMasks = void 0, t2.qualityScores = void 0;
}
function kc(t2) {
  try {
    const e2 = new Ac(t2.confidenceMasks, t2.categoryMask, t2.qualityScores);
    if (!t2.j) return e2;
    t2.j(e2);
  } finally {
    Yo(t2);
  }
}
Ac.prototype.close = Ac.prototype.close;
var Sc = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "image_in", "norm_rect", false), this.s = [], this.outputCategoryMask = false, this.outputConfidenceMasks = true, this.h = new mo(), this.v = new lo(), sn(this.h, 0, 3, this.v), sn(t2 = this.h, 0, 1, e2 = new Ls());
  }
  get baseOptions() {
    return en(this.h, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.h, 0, 1, t2);
  }
  o(t2) {
    return void 0 !== t2.displayNamesLocale ? De(this.h, 2, ae(t2.displayNamesLocale)) : "displayNamesLocale" in t2 && De(this.h, 2), "outputCategoryMask" in t2 && (this.outputCategoryMask = t2.outputCategoryMask ?? false), "outputConfidenceMasks" in t2 && (this.outputConfidenceMasks = t2.outputConfidenceMasks ?? true), super.l(t2);
  }
  I() {
    !(function(t2) {
      const e2 = rn(t2.da(), Xi, 1).filter(((t3) => (ln(t3, 1) ?? "").includes("mediapipe.tasks.TensorsToSegmentationCalculator")));
      if (t2.s = [], e2.length > 1) throw Error("The graph has more than one mediapipe.tasks.TensorsToSegmentationCalculator.");
      1 === e2.length && (en(e2[0], Di, 7)?.l()?.g() ?? /* @__PURE__ */ new Map()).forEach(((e3, n2) => {
        t2.s[Number(n2)] = ln(e3, 1) ?? "";
      }));
    })(this);
  }
  segment(t2, e2, n2) {
    const r2 = "function" != typeof e2 ? e2 : {};
    return this.j = "function" == typeof e2 ? e2 : n2, bc(this), Wa(this, t2, r2), kc(this);
  }
  Ma(t2, e2, n2, r2) {
    const i2 = "function" != typeof n2 ? n2 : {};
    return this.j = "function" == typeof n2 ? n2 : r2, bc(this), za(this, t2, i2, e2), kc(this);
  }
  Da() {
    return this.s;
  }
  m() {
    var t2 = new qi();
    Yi(t2, "image_in"), Yi(t2, "norm_rect");
    const e2 = new Di();
    Xn(e2, yo, this.h);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.image_segmenter.ImageSegmenterGraph"), ji(n2, "IMAGE:image_in"), ji(n2, "NORM_RECT:norm_rect"), n2.o(e2), Ki(t2, n2), zo(this, t2), this.outputConfidenceMasks && ($i(t2, "confidence_masks"), Vi(n2, "CONFIDENCE_MASKS:confidence_masks"), Ko(this, "confidence_masks"), this.g.ca("confidence_masks", ((t3, e3) => {
      this.confidenceMasks = t3.map(((t4) => Ka(this, t4, true, !this.j))), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("confidence_masks", ((t3) => {
      this.confidenceMasks = [], Wo(this, t3);
    }))), this.outputCategoryMask && ($i(t2, "category_mask"), Vi(n2, "CATEGORY_MASK:category_mask"), Ko(this, "category_mask"), this.g.U("category_mask", ((t3, e3) => {
      this.categoryMask = Ka(this, t3, false, !this.j), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("category_mask", ((t3) => {
      this.categoryMask = void 0, Wo(this, t3);
    }))), $i(t2, "quality_scores"), Vi(n2, "QUALITY_SCORES:quality_scores"), this.g.attachFloatVectorListener("quality_scores", ((t3, e3) => {
      this.qualityScores = t3, Wo(this, e3);
    })), this.g.attachEmptyPacketListener("quality_scores", ((t3) => {
      this.categoryMask = void 0, Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
Sc.prototype.getLabels = Sc.prototype.Da, Sc.prototype.segmentForVideo = Sc.prototype.Ma, Sc.prototype.segment = Sc.prototype.segment, Sc.prototype.setOptions = Sc.prototype.o, Sc.createFromModelPath = function(t2, e2) {
  return Xa(Sc, t2, { baseOptions: { modelAssetPath: e2 } });
}, Sc.createFromModelBuffer = function(t2, e2) {
  return Xa(Sc, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, Sc.createFromOptions = function(t2, e2) {
  return Xa(Sc, t2, e2);
};
var xc = class {
  constructor(t2, e2, n2) {
    this.confidenceMasks = t2, this.categoryMask = e2, this.qualityScores = n2;
  }
  close() {
    this.confidenceMasks?.forEach(((t2) => {
      t2.close();
    })), this.categoryMask?.close();
  }
};
xc.prototype.close = xc.prototype.close;
var Lc = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Rc = [0, oi, -2];
var Fc = [0, Qr, -3, hi, Qr, -1];
var Ic = [0, Fc];
var Mc = [0, Fc, oi, -1];
var Pc = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Oc = [0, Qr, -1, hi];
var Cc = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Uc = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
var Dc = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15];
var Nc = class extends Hn {
  constructor(t2) {
    super(t2);
  }
};
Nc.prototype.g = Ai([0, pi, [0, Dc, gi, Fc, gi, [0, Fc, Rc], gi, Ic, gi, [0, Ic, Rc], gi, Oc, gi, [0, Qr, -3, hi, vi], gi, [0, Qr, -3, hi], gi, [0, fi, Qr, -2, hi, oi, hi, -1, 2, Qr, Rc], gi, Mc, gi, [0, Mc, Rc], Qr, Rc, fi, gi, [0, Qr, -3, hi, Rc, -1], gi, [0, pi, Oc]], fi, [0, fi, oi, -1, hi]]);
var Bc = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "image_in", "norm_rect_in", false), this.outputCategoryMask = false, this.outputConfidenceMasks = true, this.h = new mo(), this.s = new lo(), sn(this.h, 0, 3, this.s), sn(t2 = this.h, 0, 1, e2 = new Ls());
  }
  get baseOptions() {
    return en(this.h, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.h, 0, 1, t2);
  }
  o(t2) {
    return "outputCategoryMask" in t2 && (this.outputCategoryMask = t2.outputCategoryMask ?? false), "outputConfidenceMasks" in t2 && (this.outputConfidenceMasks = t2.outputConfidenceMasks ?? true), super.l(t2);
  }
  segment(t2, e2, n2, r2) {
    const i2 = "function" != typeof n2 ? n2 : {};
    this.j = "function" == typeof n2 ? n2 : r2, this.qualityScores = this.categoryMask = this.confidenceMasks = void 0, n2 = this.B + 1, r2 = new Nc();
    const s2 = new Uc();
    var o2 = new Lc();
    if (pn(o2, 1, 255), sn(s2, 0, 12, o2), e2.keypoint && e2.scribble) throw Error("Cannot provide both keypoint and scribble.");
    if (e2.keypoint) {
      var a2 = new Pc();
      fn(a2, 3, true), gn(a2, 1, e2.keypoint.x), gn(a2, 2, e2.keypoint.y), on(s2, 5, Dc, a2);
    } else {
      if (!e2.scribble) throw Error("Must provide either a keypoint or a scribble.");
      for (a2 of (o2 = new Cc(), e2.scribble)) fn(e2 = new Pc(), 3, true), gn(e2, 1, a2.x), gn(e2, 2, a2.y), hn(o2, 1, Pc, e2);
      on(s2, 15, Dc, o2);
    }
    hn(r2, 1, Uc, s2), this.g.addProtoToStream(r2.g(), "drishti.RenderData", "roi_in", n2), Wa(this, t2, i2);
    t: {
      try {
        const t3 = new xc(this.confidenceMasks, this.categoryMask, this.qualityScores);
        if (!this.j) {
          var c2 = t3;
          break t;
        }
        this.j(t3);
      } finally {
        Yo(this);
      }
      c2 = void 0;
    }
    return c2;
  }
  m() {
    var t2 = new qi();
    Yi(t2, "image_in"), Yi(t2, "roi_in"), Yi(t2, "norm_rect_in");
    const e2 = new Di();
    Xn(e2, yo, this.h);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.interactive_segmenter.InteractiveSegmenterGraph"), ji(n2, "IMAGE:image_in"), ji(n2, "ROI:roi_in"), ji(n2, "NORM_RECT:norm_rect_in"), n2.o(e2), Ki(t2, n2), zo(this, t2), this.outputConfidenceMasks && ($i(t2, "confidence_masks"), Vi(n2, "CONFIDENCE_MASKS:confidence_masks"), Ko(this, "confidence_masks"), this.g.ca("confidence_masks", ((t3, e3) => {
      this.confidenceMasks = t3.map(((t4) => Ka(this, t4, true, !this.j))), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("confidence_masks", ((t3) => {
      this.confidenceMasks = [], Wo(this, t3);
    }))), this.outputCategoryMask && ($i(t2, "category_mask"), Vi(n2, "CATEGORY_MASK:category_mask"), Ko(this, "category_mask"), this.g.U("category_mask", ((t3, e3) => {
      this.categoryMask = Ka(this, t3, false, !this.j), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("category_mask", ((t3) => {
      this.categoryMask = void 0, Wo(this, t3);
    }))), $i(t2, "quality_scores"), Vi(n2, "QUALITY_SCORES:quality_scores"), this.g.attachFloatVectorListener("quality_scores", ((t3, e3) => {
      this.qualityScores = t3, Wo(this, e3);
    })), this.g.attachEmptyPacketListener("quality_scores", ((t3) => {
      this.categoryMask = void 0, Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
Bc.prototype.segment = Bc.prototype.segment, Bc.prototype.setOptions = Bc.prototype.o, Bc.createFromModelPath = function(t2, e2) {
  return Xa(Bc, t2, { baseOptions: { modelAssetPath: e2 } });
}, Bc.createFromModelBuffer = function(t2, e2) {
  return Xa(Bc, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, Bc.createFromOptions = function(t2, e2) {
  return Xa(Bc, t2, e2);
};
var Gc = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "input_frame_gpu", "norm_rect", false), this.j = { detections: [] }, sn(t2 = this.h = new _o(), 0, 1, e2 = new Ls());
  }
  get baseOptions() {
    return en(this.h, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.h, 0, 1, t2);
  }
  o(t2) {
    return void 0 !== t2.displayNamesLocale ? De(this.h, 2, ae(t2.displayNamesLocale)) : "displayNamesLocale" in t2 && De(this.h, 2), void 0 !== t2.maxResults ? pn(this.h, 3, t2.maxResults) : "maxResults" in t2 && De(this.h, 3), void 0 !== t2.scoreThreshold ? gn(this.h, 4, t2.scoreThreshold) : "scoreThreshold" in t2 && De(this.h, 4), void 0 !== t2.categoryAllowlist ? mn(this.h, 5, t2.categoryAllowlist) : "categoryAllowlist" in t2 && De(this.h, 5), void 0 !== t2.categoryDenylist ? mn(this.h, 6, t2.categoryDenylist) : "categoryDenylist" in t2 && De(this.h, 6), this.l(t2);
  }
  D(t2, e2) {
    return this.j = { detections: [] }, Wa(this, t2, e2), this.j;
  }
  F(t2, e2, n2) {
    return this.j = { detections: [] }, za(this, t2, n2, e2), this.j;
  }
  m() {
    var t2 = new qi();
    Yi(t2, "input_frame_gpu"), Yi(t2, "norm_rect"), $i(t2, "detections");
    const e2 = new Di();
    Xn(e2, vo, this.h);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.ObjectDetectorGraph"), ji(n2, "IMAGE:input_frame_gpu"), ji(n2, "NORM_RECT:norm_rect"), Vi(n2, "DETECTIONS:detections"), n2.o(e2), Ki(t2, n2), this.g.attachProtoVectorListener("detections", ((t3, e3) => {
      for (const e4 of t3) t3 = os(e4), this.j.detections.push(bo(t3));
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("detections", ((t3) => {
      Wo(this, t3);
    })), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
Gc.prototype.detectForVideo = Gc.prototype.F, Gc.prototype.detect = Gc.prototype.D, Gc.prototype.setOptions = Gc.prototype.o, Gc.createFromModelPath = async function(t2, e2) {
  return Xa(Gc, t2, { baseOptions: { modelAssetPath: e2 } });
}, Gc.createFromModelBuffer = function(t2, e2) {
  return Xa(Gc, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, Gc.createFromOptions = function(t2, e2) {
  return Xa(Gc, t2, e2);
};
var jc = class {
  constructor(t2, e2, n2) {
    this.landmarks = t2, this.worldLandmarks = e2, this.segmentationMasks = n2;
  }
  close() {
    this.segmentationMasks?.forEach(((t2) => {
      t2.close();
    }));
  }
};
function Vc(t2) {
  t2.landmarks = [], t2.worldLandmarks = [], t2.segmentationMasks = void 0;
}
function Xc(t2) {
  try {
    const e2 = new jc(t2.landmarks, t2.worldLandmarks, t2.segmentationMasks);
    if (!t2.s) return e2;
    t2.s(e2);
  } finally {
    Yo(t2);
  }
}
jc.prototype.close = jc.prototype.close;
var Hc = class extends Ya {
  constructor(t2, e2) {
    super(new Va(t2, e2), "image_in", "norm_rect", false), this.landmarks = [], this.worldLandmarks = [], this.outputSegmentationMasks = false, sn(t2 = this.h = new Eo(), 0, 1, e2 = new Ls()), this.v = new ro(), sn(this.h, 0, 3, this.v), this.j = new no(), sn(this.h, 0, 2, this.j), pn(this.j, 4, 1), gn(this.j, 2, 0.5), gn(this.v, 2, 0.5), gn(this.h, 4, 0.5);
  }
  get baseOptions() {
    return en(this.h, Ls, 1);
  }
  set baseOptions(t2) {
    sn(this.h, 0, 1, t2);
  }
  o(t2) {
    return "numPoses" in t2 && pn(this.j, 4, t2.numPoses ?? 1), "minPoseDetectionConfidence" in t2 && gn(this.j, 2, t2.minPoseDetectionConfidence ?? 0.5), "minTrackingConfidence" in t2 && gn(this.h, 4, t2.minTrackingConfidence ?? 0.5), "minPosePresenceConfidence" in t2 && gn(this.v, 2, t2.minPosePresenceConfidence ?? 0.5), "outputSegmentationMasks" in t2 && (this.outputSegmentationMasks = t2.outputSegmentationMasks ?? false), this.l(t2);
  }
  D(t2, e2, n2) {
    const r2 = "function" != typeof e2 ? e2 : {};
    return this.s = "function" == typeof e2 ? e2 : n2, Vc(this), Wa(this, t2, r2), Xc(this);
  }
  F(t2, e2, n2, r2) {
    const i2 = "function" != typeof n2 ? n2 : {};
    return this.s = "function" == typeof n2 ? n2 : r2, Vc(this), za(this, t2, i2, e2), Xc(this);
  }
  m() {
    var t2 = new qi();
    Yi(t2, "image_in"), Yi(t2, "norm_rect"), $i(t2, "normalized_landmarks"), $i(t2, "world_landmarks"), $i(t2, "segmentation_masks");
    const e2 = new Di();
    Xn(e2, wo, this.h);
    const n2 = new Xi();
    Gi(n2, "mediapipe.tasks.vision.pose_landmarker.PoseLandmarkerGraph"), ji(n2, "IMAGE:image_in"), ji(n2, "NORM_RECT:norm_rect"), Vi(n2, "NORM_LANDMARKS:normalized_landmarks"), Vi(n2, "WORLD_LANDMARKS:world_landmarks"), n2.o(e2), Ki(t2, n2), zo(this, t2), this.g.attachProtoVectorListener("normalized_landmarks", ((t3, e3) => {
      this.landmarks = [];
      for (const e4 of t3) t3 = us(e4), this.landmarks.push(ko(t3));
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("normalized_landmarks", ((t3) => {
      this.landmarks = [], Wo(this, t3);
    })), this.g.attachProtoVectorListener("world_landmarks", ((t3, e3) => {
      this.worldLandmarks = [];
      for (const e4 of t3) t3 = cs(e4), this.worldLandmarks.push(So(t3));
      Wo(this, e3);
    })), this.g.attachEmptyPacketListener("world_landmarks", ((t3) => {
      this.worldLandmarks = [], Wo(this, t3);
    })), this.outputSegmentationMasks && (Vi(n2, "SEGMENTATION_MASK:segmentation_masks"), Ko(this, "segmentation_masks"), this.g.ca("segmentation_masks", ((t3, e3) => {
      this.segmentationMasks = t3.map(((t4) => Ka(this, t4, true, !this.s))), Wo(this, e3);
    })), this.g.attachEmptyPacketListener("segmentation_masks", ((t3) => {
      this.segmentationMasks = [], Wo(this, t3);
    }))), t2 = t2.g(), this.setGraph(new Uint8Array(t2), true);
  }
};
Hc.prototype.detectForVideo = Hc.prototype.F, Hc.prototype.detect = Hc.prototype.D, Hc.prototype.setOptions = Hc.prototype.o, Hc.createFromModelPath = function(t2, e2) {
  return Xa(Hc, t2, { baseOptions: { modelAssetPath: e2 } });
}, Hc.createFromModelBuffer = function(t2, e2) {
  return Xa(Hc, t2, { baseOptions: { modelAssetBuffer: e2 } });
}, Hc.createFromOptions = function(t2, e2) {
  return Xa(Hc, t2, e2);
}, Hc.POSE_CONNECTIONS = mc;

// packages/gesture-control/src/gesture/landmarks.ts
var LANDMARK = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20
};
function dist2d(a2, b2) {
  const dx = a2.x - b2.x;
  const dy = a2.y - b2.y;
  return Math.hypot(dx, dy);
}
function midpoint(a2, b2) {
  return { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
}

// packages/gesture-control/src/gesture/OneEuroFilter.ts
function smoothingAlpha(cutoffHz, dtSec) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}
var LowPass = class {
  constructor() {
    __publicField(this, "value", null);
  }
  filter(x2, alpha) {
    this.value = this.value === null ? x2 : alpha * x2 + (1 - alpha) * this.value;
    return this.value;
  }
  reset() {
    this.value = null;
  }
  get initialized() {
    return this.value !== null;
  }
};
var OneEuroFilter = class {
  /**
   * @param minCutoff Baseline cutoff (Hz). Lower → smoother but laggier when still.
   * @param beta      Speed coefficient. Higher → less lag during fast moves.
   * @param dCutoff   Cutoff for the derivative low-pass (Hz). 1.0 is fine.
   */
  constructor(minCutoff = 1, beta = 0.01, dCutoff = 1) {
    __publicField(this, "minCutoff", minCutoff);
    __publicField(this, "beta", beta);
    __publicField(this, "dCutoff", dCutoff);
    __publicField(this, "signal", new LowPass());
    __publicField(this, "derivative", new LowPass());
    __publicField(this, "lastTimeSec", null);
    __publicField(this, "lastRaw", 0);
  }
  reset() {
    this.signal.reset();
    this.derivative.reset();
    this.lastTimeSec = null;
    this.lastRaw = 0;
  }
  /** @param timeSec strictly-increasing timestamp in seconds. */
  filter(x2, timeSec) {
    let dt2 = this.lastTimeSec === null ? 1 / 60 : timeSec - this.lastTimeSec;
    if (dt2 <= 0) dt2 = 1 / 60;
    this.lastTimeSec = timeSec;
    const dRaw = this.signal.initialized ? (x2 - this.lastRaw) / dt2 : 0;
    this.lastRaw = x2;
    const edRaw = this.derivative.filter(dRaw, smoothingAlpha(this.dCutoff, dt2));
    const cutoff = this.minCutoff + this.beta * Math.abs(edRaw);
    return this.signal.filter(x2, smoothingAlpha(cutoff, dt2));
  }
};

// packages/gesture-control/src/gesture/pinch.ts
function pinchDistance(landmarks) {
  const thumb = landmarks[LANDMARK.THUMB_TIP];
  const index = landmarks[LANDMARK.INDEX_TIP];
  const wrist = landmarks[LANDMARK.WRIST];
  const middleMcp = landmarks[LANDMARK.MIDDLE_MCP];
  const handSize = dist2d(wrist, middleMcp) || 1e-6;
  return dist2d(thumb, index) / handSize;
}
var PinchDetector = class {
  constructor(onThreshold = 0.35, offThreshold = 0.5, persistFrames = 2) {
    __publicField(this, "onThreshold", onThreshold);
    __publicField(this, "offThreshold", offThreshold);
    __publicField(this, "persistFrames", persistFrames);
    __publicField(this, "pinching", false);
    __publicField(this, "pendingFrames", 0);
  }
  reset() {
    this.pinching = false;
    this.pendingFrames = 0;
  }
  get isPinching() {
    return this.pinching;
  }
  /** Feed one frame's distance. Returns true if the committed state CHANGED. */
  update(distance) {
    const target = this.pinching ? distance < this.offThreshold : distance < this.onThreshold;
    if (target === this.pinching) {
      this.pendingFrames = 0;
      return false;
    }
    this.pendingFrames += 1;
    if (this.pendingFrames >= this.persistFrames) {
      this.pinching = target;
      this.pendingFrames = 0;
      return true;
    }
    return false;
  }
};

// packages/gesture-control/src/gesture/commands.ts
var GESTURE_COMMANDS = {
  Open_Palm: { name: "halt-all", holdMs: -1 },
  // holdMs filled from palmHoldMs
  Thumb_Up: { name: "approve" },
  Victory: { name: "new-session" }
};
var CommandDetector = class {
  constructor(palmHoldMs = 1e3) {
    __publicField(this, "palmHoldMs", palmHoldMs);
    /** gesture category → timestamp (ms) it was first seen in the current hold. */
    __publicField(this, "heldSince", /* @__PURE__ */ new Map());
    /** gestures that already fired during the current hold (cleared on release). */
    __publicField(this, "fired", /* @__PURE__ */ new Set());
  }
  reset() {
    this.heldSince.clear();
    this.fired.clear();
  }
  holdMsFor(spec) {
    return spec.holdMs === -1 ? this.palmHoldMs : spec.holdMs ?? 0;
  }
  /**
   * Feed the set of command-gestures currently shown (across all hands).
   * @returns the commands that fired on this frame (usually empty).
   */
  update(gestures, nowMs) {
    for (const g2 of [...this.heldSince.keys()]) {
      if (!gestures.has(g2)) {
        this.heldSince.delete(g2);
        this.fired.delete(g2);
      }
    }
    const fired = [];
    for (const g2 of gestures) {
      const spec = GESTURE_COMMANDS[g2];
      if (!spec) continue;
      const since = this.heldSince.get(g2) ?? nowMs;
      if (!this.heldSince.has(g2)) this.heldSince.set(g2, since);
      if (this.fired.has(g2)) continue;
      if (nowMs - since >= this.holdMsFor(spec)) {
        fired.push(spec.name);
        this.fired.add(g2);
      }
    }
    return fired;
  }
  /** 0–1 charge of the held halt-all gesture (1 once fired, 0 when released). */
  haltProgress(nowMs) {
    const since = this.heldSince.get("Open_Palm");
    if (since === void 0) return 0;
    if (this.fired.has("Open_Palm")) return 1;
    return Math.min(1, (nowMs - since) / this.palmHoldMs);
  }
};

// packages/gesture-control/src/gesture/GestureController.ts
var DEFAULTS = {
  numHands: 1,
  deviceId: "",
  pinchOn: 0.35,
  pinchOff: 0.5,
  minCutoff: 1,
  beta: 0.01,
  palmHoldMs: 1e3,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6,
  // Pinned to the @mediapipe/tasks-vision version in package.json.
  wasmBase: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm",
  modelUrl: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
};
var GestureController = class {
  constructor(options) {
    __publicField(this, "opts");
    __publicField(this, "recognizer", null);
    __publicField(this, "stream", null);
    __publicField(this, "rafId", null);
    __publicField(this, "running", false);
    // Timestamps must be strictly increasing for recognizeForVideo.
    __publicField(this, "lastVideoTime", -1);
    __publicField(this, "lastTimestamp", -1);
    // FPS tracking (rolling over a short window).
    __publicField(this, "frameTimes", []);
    // Per-hand smoothing + pinch state, keyed by handedness ("Left"/"Right") so a
    // hand keeps its own filters even when MediaPipe reorders the hands array.
    __publicField(this, "handStates", /* @__PURE__ */ new Map());
    // Discrete gesture → command bus (debounced; Open_Palm held = halt-all).
    __publicField(this, "commands");
    // Internal storage is intentionally loose; the public on/off/emit signatures
    // below keep callers fully type-safe per event name.
    __publicField(this, "listeners", {});
    // ---- Loop ------------------------------------------------------------
    __publicField(this, "loop", () => {
      if (!this.running || !this.recognizer) return;
      this.rafId = requestAnimationFrame(this.loop);
      const video = this.opts.video;
      if (video.readyState < 2) return;
      let ts2 = performance.now();
      if (ts2 <= this.lastTimestamp) ts2 = this.lastTimestamp + 1;
      this.lastTimestamp = ts2;
      if (video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = video.currentTime;
      let result;
      try {
        result = this.recognizer.recognizeForVideo(video, ts2);
      } catch (err) {
        console.error("recognizeForVideo failed", err);
        return;
      }
      this.trackFps(ts2);
      this.publish(result, ts2);
    });
    this.opts = {
      surface: options.surface ?? options.video,
      numHands: options.numHands ?? DEFAULTS.numHands,
      deviceId: options.deviceId ?? DEFAULTS.deviceId,
      pinchOn: options.pinchOn ?? DEFAULTS.pinchOn,
      pinchOff: options.pinchOff ?? DEFAULTS.pinchOff,
      minCutoff: options.minCutoff ?? DEFAULTS.minCutoff,
      beta: options.beta ?? DEFAULTS.beta,
      palmHoldMs: options.palmHoldMs ?? DEFAULTS.palmHoldMs,
      minDetectionConfidence: options.minDetectionConfidence ?? DEFAULTS.minDetectionConfidence,
      minTrackingConfidence: options.minTrackingConfidence ?? DEFAULTS.minTrackingConfidence,
      wasmBase: options.wasmBase ?? DEFAULTS.wasmBase,
      modelUrl: options.modelUrl ?? DEFAULTS.modelUrl,
      video: options.video
    };
    this.commands = new CommandDetector(this.opts.palmHoldMs);
  }
  /** Get (or lazily create) the smoothing + pinch state for one hand. */
  handState(key) {
    let state = this.handStates.get(key);
    if (!state) {
      state = {
        cursorX: new OneEuroFilter(this.opts.minCutoff, this.opts.beta),
        cursorY: new OneEuroFilter(this.opts.minCutoff, this.opts.beta),
        pinch: new PinchDetector(this.opts.pinchOn, this.opts.pinchOff),
        label: key,
        lastX: 0,
        lastY: 0
      };
      this.handStates.set(key, state);
    }
    return state;
  }
  // ---- Event emitter ---------------------------------------------------
  on(event, handler) {
    var _a2;
    ((_a2 = this.listeners)[event] ?? (_a2[event] = /* @__PURE__ */ new Set())).add(handler);
    return this;
  }
  off(event, handler) {
    this.listeners[event]?.delete(handler);
    return this;
  }
  emit(event, payload) {
    this.listeners[event]?.forEach((h2) => h2(payload));
  }
  // ---- Lifecycle -------------------------------------------------------
  /** Request the camera, load the model, and start the recognition loop. */
  async start() {
    if (this.running) return;
    await this.openCamera();
    await this.loadRecognizer();
    this.running = true;
    this.lastVideoTime = -1;
    this.lastTimestamp = -1;
    this.frameTimes = [];
    this.handStates.clear();
    this.commands.reset();
    this.loop();
  }
  /** Stop the loop, release the camera, and close the recognizer. */
  stop() {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t2) => t2.stop());
      this.stream = null;
    }
    this.opts.video.srcObject = null;
    this.recognizer?.close();
    this.recognizer = null;
  }
  /** The camera currently in use (resolved deviceId), or "" if not started. */
  get deviceId() {
    return this.opts.deviceId;
  }
  /** List available video input devices. Labels are only populated once the
   *  user has granted camera permission (i.e. after the first start()). */
  async listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }
  /** Switch to a different camera. Reopens the stream live if already running. */
  async useCamera(deviceId) {
    this.opts.deviceId = deviceId;
    if (!this.running) return;
    if (this.stream) {
      this.stream.getTracks().forEach((t2) => t2.stop());
      this.stream = null;
    }
    await this.openCamera();
    this.handStates.clear();
    this.lastVideoTime = -1;
  }
  // ---- Setup -----------------------------------------------------------
  async openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is not available (needs a secure context).");
    }
    const videoConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60, max: 60 }
    };
    if (this.opts.deviceId) videoConstraints.deviceId = { exact: this.opts.deviceId };
    else videoConstraints.facingMode = "user";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false
    });
    this.stream = stream;
    this.opts.deviceId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? this.opts.deviceId;
    const video = this.opts.video;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    if (!video.videoWidth) {
      await new Promise((resolve) => {
        const onMeta = () => {
          video.removeEventListener("loadedmetadata", onMeta);
          resolve();
        };
        video.addEventListener("loadedmetadata", onMeta);
      });
    }
  }
  async loadRecognizer() {
    const fileset = await Po.forVisionTasks(this.opts.wasmBase);
    const build = (delegate) => fc.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: this.opts.modelUrl,
        delegate
      },
      runningMode: "VIDEO",
      numHands: this.opts.numHands,
      minHandDetectionConfidence: this.opts.minDetectionConfidence,
      minHandPresenceConfidence: this.opts.minDetectionConfidence,
      minTrackingConfidence: this.opts.minTrackingConfidence
    });
    try {
      this.recognizer = await build("GPU");
    } catch (err) {
      console.warn("[gesture] GPU delegate failed; falling back to CPU.", err);
      this.recognizer = await build("CPU");
    }
  }
  trackFps(nowMs) {
    this.frameTimes.push(nowMs);
    const windowStart = nowMs - 1e3;
    while (this.frameTimes.length && this.frameTimes[0] < windowStart) {
      this.frameTimes.shift();
    }
  }
  get fps() {
    if (this.frameTimes.length < 2) return 0;
    const span = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
    if (span <= 0) return 0;
    return Math.round((this.frameTimes.length - 1) / span * 1e3);
  }
  publish(result, ts2) {
    const allLandmarks = result.landmarks ?? [];
    const handedness = result.handedness ?? [];
    const gestures = result.gestures ?? [];
    const tSec = ts2 / 1e3;
    const rect = this.opts.surface.getBoundingClientRect();
    const hands = [];
    const activeKeys = /* @__PURE__ */ new Set();
    for (let i2 = 0; i2 < allLandmarks.length; i2++) {
      const lm = allLandmarks[i2];
      if (!lm || lm.length === 0) continue;
      const label = handedness[i2]?.[0]?.categoryName ?? `hand${i2}`;
      let key = label;
      if (activeKeys.has(key)) key = `${label}#${i2}`;
      activeKeys.add(key);
      const state = this.handState(key);
      const mid = midpoint(lm[LANDMARK.THUMB_TIP], lm[LANDMARK.INDEX_TIP]);
      const cursor = {
        x: state.cursorX.filter(mid.x, tSec),
        y: state.cursorY.filter(mid.y, tSec)
      };
      const pinchDist = pinchDistance(lm);
      const changed = state.pinch.update(pinchDist);
      const gesture = gestures[i2]?.[0]?.categoryName ?? null;
      const sx = (1 - cursor.x) * rect.width;
      const sy = cursor.y * rect.height;
      state.lastX = sx;
      state.lastY = sy;
      const pointer = { hand: label, x: sx, y: sy };
      if (state.pinch.isPinching) {
        this.emit(changed ? "grab" : "drag", pointer);
      } else if (changed) {
        this.emit("drop", pointer);
      }
      hands.push({
        handedness: label,
        cursor,
        pinchDist,
        pinching: state.pinch.isPinching,
        gesture: gesture && gesture !== "None" ? gesture : null
      });
    }
    for (const key of [...this.handStates.keys()]) {
      if (activeKeys.has(key)) continue;
      const stale = this.handStates.get(key);
      if (stale.pinch.isPinching) {
        this.emit("drop", { hand: stale.label, x: stale.lastX, y: stale.lastY });
      }
      this.handStates.delete(key);
    }
    const commandGestures = /* @__PURE__ */ new Set();
    for (const h2 of hands) {
      if (!h2.pinching && h2.gesture) commandGestures.add(h2.gesture);
    }
    for (const name of this.commands.update(commandGestures, ts2)) {
      this.emit("command", { name });
    }
    this.emit("status", {
      fps: this.fps,
      hands,
      haltProgress: this.commands.haltProgress(ts2)
    });
    this.emit("results", { result, timestampMs: ts2 });
  }
};

// packages/gesture-control/src/codeman/entry.ts
var TAB_SELECTOR = ".session-tab";
var PANEL_SELECTOR = ".cg-float";
var WINDOW_SELECTOR = ".subagent-window, .ultracode-window";
var DOCK_SELECTOR = ".session-tabs";
var CLICK_SELECTOR = "#runBtn, .btn-shell";
var Z2 = 2147483e3;
var FLOAT_W = 640;
var FLOAT_H = 420;
var DETACH_PULL_PX = 70;
var TAP_CANCEL_PX = 45;
var handColor = (handedness, pinching) => pinching ? "#4ade80" : handedness === "Right" ? "#a78bfa" : "#38bdf8";
var GestureBridge = class {
  constructor() {
    __publicField(this, "surface");
    __publicField(this, "canvas");
    __publicField(this, "ctx");
    __publicField(this, "video");
    __publicField(this, "button");
    __publicField(this, "camBtn");
    __publicField(this, "status");
    __publicField(this, "gc");
    __publicField(this, "running", false);
    /** Camera view: full-viewport dimmed background, or small corner preview. */
    __publicField(this, "camMode", "full");
    /** Per-hand in-progress grab (a tab being pulled out, or a panel being moved). */
    __publicField(this, "grabs", /* @__PURE__ */ new Map());
    /** Per-hand in-progress button pinch (fires on release if it didn't drift). */
    __publicField(this, "taps", /* @__PURE__ */ new Map());
    /** Live floating panels, keyed by session id (idempotent per id). */
    __publicField(this, "floats", /* @__PURE__ */ new Map());
    /** rAF coalescing for connector-line redraws while dragging an agent window. */
    __publicField(this, "connectorRedrawScheduled", false);
    injectStyles();
    this.surface = el("div", "cg-surface");
    this.canvas = el("canvas", "cg-canvas");
    this.video = el("video", "cg-preview");
    this.video.muted = true;
    this.video.playsInline = true;
    this.applyCamMode();
    const dock = el("div", "cg-dock");
    this.button = el("button", "cg-btn");
    this.button.textContent = "\u{1F590} Gesture";
    this.camBtn = el("button", "cg-btn cg-btn-icon");
    this.camBtn.textContent = "\u26F6";
    this.camBtn.title = "Toggle camera size (fullscreen / corner)";
    this.status = el("span", "cg-status");
    this.status.textContent = "off";
    dock.append(this.button, this.camBtn, this.status);
    document.body.append(this.surface, this.video, this.canvas, dock);
    this.ctx = this.canvas.getContext("2d");
    this.sizeCanvas();
    window.addEventListener("resize", () => this.sizeCanvas());
    this.gc = new GestureController({
      video: this.video,
      surface: this.surface,
      numHands: 1,
      // Self-host the MediaPipe runtime + model from Codeman (same-origin) instead
      // of the CDN, so an ad/content blocker, offline desk, or strict browser
      // can't break startup (the CDN failure surfaced as `failed: {isTrusted}` —
      // a resource load-error Event). Served from public/gesture/.
      wasmBase: "/gesture/wasm",
      modelUrl: "/gesture/gesture_recognizer.task"
    });
    this.gc.on("grab", (p2) => this.onGrab(p2.hand, p2.x, p2.y));
    this.gc.on("drag", (p2) => this.onDrag(p2.hand, p2.x, p2.y));
    this.gc.on("drop", (p2) => this.onDrop(p2.hand, p2.x, p2.y));
    this.gc.on("status", ({ fps, hands }) => this.onStatus(fps, hands));
    this.button.addEventListener("click", () => void this.toggle());
    this.camBtn.addEventListener("click", () => this.toggleCamMode());
  }
  async toggle() {
    if (this.running) {
      this.gc.stop();
      this.running = false;
      this.cancelAllGrabs();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.button.classList.remove("on");
      this.status.textContent = "off";
      return;
    }
    this.button.disabled = true;
    this.status.textContent = "starting\u2026";
    try {
      await this.gc.start();
      this.running = true;
      this.button.classList.add("on");
      this.status.textContent = "on \u2014 pinch a tab, window, or button";
    } catch (err) {
      const msg = describeError(err);
      this.status.textContent = `failed: ${msg}`;
      this.status.title = msg;
      console.error("[gesture] start failed", err);
    } finally {
      this.button.disabled = false;
    }
  }
  toggleCamMode() {
    this.camMode = this.camMode === "full" ? "pip" : "full";
    this.applyCamMode();
  }
  applyCamMode() {
    this.video.classList.toggle("cg-full", this.camMode === "full");
    this.video.classList.toggle("cg-pip", this.camMode === "pip");
  }
  /** Top-most element matching `sel` at a viewport point (overlays are
   *  click-through, so elementFromPoint sees the dashboard beneath). */
  hitClosest(x2, y2, sel) {
    const hit = document.elementFromPoint(x2, y2);
    return hit?.closest(sel) ?? null;
  }
  onGrab(hand, x2, y2) {
    const panelEl = this.hitClosest(x2, y2, PANEL_SELECTOR);
    const panelId = panelEl?.dataset.id;
    if (panelEl && panelId) {
      const float = this.floats.get(panelId);
      if (float) {
        const rect = panelEl.getBoundingClientRect();
        panelEl.style.pointerEvents = "none";
        panelEl.classList.add("cg-float-grabbed");
        this.grabs.set(hand, {
          kind: "panel",
          id: panelId,
          panel: float,
          dx: x2 - rect.left,
          dy: y2 - rect.top,
          overDock: false
        });
        this.status.textContent = "moving \u2014 drop over tabs to re-dock";
        return;
      }
    }
    const win = this.hitClosest(x2, y2, WINDOW_SELECTOR);
    if (win) {
      const rect = win.getBoundingClientRect();
      win.style.bottom = "auto";
      win.classList.add("cg-win-grabbed");
      this.bringWindowToFront(win);
      this.grabs.set(hand, { kind: "window", el: win, dx: x2 - rect.left, dy: y2 - rect.top });
      this.status.textContent = "moving window";
      return;
    }
    const tab = this.hitClosest(x2, y2, TAB_SELECTOR);
    const id = tab?.dataset.id;
    if (tab && id) {
      const rect = tab.getBoundingClientRect();
      const ghost = tab.cloneNode(true);
      ghost.classList.add("cg-ghost");
      ghost.removeAttribute("id");
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      document.body.append(ghost);
      tab.classList.add("cg-grabbed");
      this.grabs.set(hand, { kind: "tab", id, tab, ghost, ox: x2, oy: y2, armed: false });
      this.positionGhost(ghost, x2, y2);
      return;
    }
    const btn = this.hitClosest(x2, y2, CLICK_SELECTOR);
    if (btn) {
      const label = (btn.textContent || btn.getAttribute("title") || "button").trim();
      btn.classList.add("cg-tap-armed");
      this.taps.set(hand, { el: btn, label, ox: x2, oy: y2 });
      this.status.textContent = `release to ${label.toLowerCase()}`;
    }
  }
  onDrag(hand, x2, y2) {
    const grab = this.grabs.get(hand);
    if (grab?.kind === "tab") {
      this.positionGhost(grab.ghost, x2, y2);
      const pulled = Math.hypot(x2 - grab.ox, y2 - grab.oy) >= DETACH_PULL_PX;
      if (pulled !== grab.armed) {
        grab.armed = pulled;
        grab.ghost.classList.toggle("cg-armed", pulled);
        this.status.textContent = pulled ? "release to float out" : "on \u2014 pinch a tab";
      }
      return;
    }
    if (grab?.kind === "panel") {
      this.moveFloat(grab.panel, x2 - grab.dx, y2 - grab.dy);
      const overDock = !!this.hitClosest(x2, y2, DOCK_SELECTOR);
      if (overDock !== grab.overDock) {
        grab.overDock = overDock;
        grab.panel.el.classList.toggle("cg-redock", overDock);
        this.status.textContent = overDock ? "release to re-dock" : "moving panel";
      }
      return;
    }
    if (grab?.kind === "window") {
      this.moveWindow(grab.el, x2 - grab.dx, y2 - grab.dy);
      return;
    }
    const tap = this.taps.get(hand);
    if (tap && Math.hypot(x2 - tap.ox, y2 - tap.oy) > TAP_CANCEL_PX) {
      tap.el.classList.remove("cg-tap-armed");
      this.taps.delete(hand);
      this.status.textContent = "on \u2014 pinch a tab, window, or button";
    }
  }
  onDrop(hand, x2, y2) {
    const grab = this.grabs.get(hand);
    if (grab?.kind === "tab") {
      this.grabs.delete(hand);
      grab.ghost.remove();
      grab.tab.classList.remove("cg-grabbed");
      if (grab.armed) this.floatPanel(grab.id, x2, y2);
      else this.flash("cancelled");
      return;
    }
    if (grab?.kind === "panel") {
      this.grabs.delete(hand);
      grab.panel.el.style.pointerEvents = "";
      grab.panel.el.classList.remove("cg-float-grabbed", "cg-redock");
      if (grab.overDock) this.redock(grab.id);
      else this.flash("placed");
      return;
    }
    if (grab?.kind === "window") {
      this.grabs.delete(hand);
      grab.el.classList.remove("cg-win-grabbed");
      this.connectorRedrawScheduled = false;
      this.redrawWindowConnectors();
      try {
        window.app?.saveSubagentWindowStates?.();
      } catch {
      }
      this.flash("placed window");
      return;
    }
    const tap = this.taps.get(hand);
    if (tap) {
      this.taps.delete(hand);
      tap.el.classList.remove("cg-tap-armed");
      tap.el.click();
      this.flash(tap.label.toLowerCase());
    }
  }
  /** Pop a session into an in-page floating panel (an iframe of its solo route)
   *  centered on the drop point. Unlike OS-window detach, the panel lives in
   *  this page's DOM, so the hand can re-grab and move it. Idempotent per id:
   *  re-floating an existing id just repositions the panel it already has. */
  floatPanel(id, x2, y2) {
    let float = this.floats.get(id);
    if (!float) {
      const container = el("div", "cg-float");
      container.dataset.id = id;
      const bar = el("div", "cg-float-bar");
      bar.textContent = `session ${id}`;
      const frame = el("iframe", "cg-float-frame");
      frame.src = `/session/${encodeURIComponent(id)}`;
      frame.title = `Session ${id}`;
      container.append(bar, frame);
      document.body.append(container);
      float = { id, el: container };
      this.floats.set(id, float);
      this.flash("floated out");
    } else {
      this.flash("re-floated");
    }
    this.moveFloat(float, x2 - FLOAT_W / 2, y2 - FLOAT_H / 2);
  }
  /** Re-dock a floated session: drop its in-page panel. The original
   *  `.session-tab` was never removed, so the session is simply back to plain
   *  tab form. Mirrors Codeman's own `.detached` → attach toggle. */
  redock(id) {
    const float = this.floats.get(id);
    if (!float) return;
    float.el.remove();
    this.floats.delete(id);
    this.flash("re-docked");
  }
  /** Position a float by its top-left corner, clamped to stay on-screen. */
  moveFloat(float, left, top) {
    const l = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - FLOAT_W));
    const t2 = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - FLOAT_H));
    float.el.style.left = `${l}px`;
    float.el.style.top = `${t2}px`;
  }
  /** Move a dashboard-owned agent window by its top-left, clamped on-screen, then
   *  redraw its connector line. The window self-positions via `style.left/top` and
   *  app.js's connector redraw reads live rects, so this tracks without touching
   *  app.js internals. Guards on `isConnected`: ultracode windows can be torn down
   *  (SSE reconnect / auto-close) while still held. Clamps to `innerWidth/Height`,
   *  which equals the *spanned* viewport in a multi-monitor window — so the window
   *  can still travel across the physical monitor seam, just not off-screen. */
  moveWindow(el2, left, top) {
    if (!el2.isConnected) return;
    const w2 = el2.offsetWidth || 380;
    const h2 = el2.offsetHeight || 320;
    const l = Math.min(Math.max(4, left), Math.max(4, window.innerWidth - w2 - 4));
    const t2 = Math.min(Math.max(4, top), Math.max(4, window.innerHeight - h2 - 4));
    el2.style.left = `${l}px`;
    el2.style.top = `${t2}px`;
    this.redrawWindowConnectors();
  }
  /** Ask app.js to redraw all connector lines (subagent + ultracode), coalesced to
   *  one per frame so per-frame drags don't thrash. `updateConnectionLines()` is
   *  itself debounced in app.js, but we rAF-gate too in case an older dashboard
   *  build isn't, and to no-op cleanly when app.js isn't present (standalone). */
  redrawWindowConnectors() {
    if (this.connectorRedrawScheduled) return;
    this.connectorRedrawScheduled = true;
    requestAnimationFrame(() => {
      this.connectorRedrawScheduled = false;
      try {
        window.app?.updateConnectionLines?.();
      } catch {
      }
    });
  }
  /** Pop a grabbed window above its siblings using app.js's own z-counter, so a
   *  picked-up window comes to the front like a real focus. Cosmetic + best-effort. */
  bringWindowToFront(el2) {
    const app = window.app;
    if (!app) return;
    try {
      if (el2.classList.contains("ultracode-window")) {
        app.ultracodeWindowZIndex = (app.ultracodeWindowZIndex ?? 1e3) + 1;
        el2.style.zIndex = String(app.ultracodeWindowZIndex);
      } else {
        app.subagentWindowZIndex = (app.subagentWindowZIndex ?? 1e3) + 1;
        el2.style.zIndex = String(app.subagentWindowZIndex);
      }
    } catch {
    }
  }
  positionGhost(ghost, x2, y2) {
    ghost.style.left = `${x2}px`;
    ghost.style.top = `${y2}px`;
  }
  cancelAllGrabs() {
    for (const grab of this.grabs.values()) {
      if (grab.kind === "tab") {
        grab.ghost.remove();
        grab.tab.classList.remove("cg-grabbed");
      } else if (grab.kind === "panel") {
        grab.panel.el.style.pointerEvents = "";
        grab.panel.el.classList.remove("cg-float-grabbed", "cg-redock");
      } else {
        grab.el.classList.remove("cg-win-grabbed");
      }
    }
    this.grabs.clear();
    for (const tap of this.taps.values()) tap.el.classList.remove("cg-tap-armed");
    this.taps.clear();
    document.querySelectorAll(`${TAB_SELECTOR}.cg-grabbed, .cg-tap-armed, .cg-win-grabbed`).forEach((t2) => t2.classList.remove("cg-grabbed", "cg-tap-armed", "cg-win-grabbed"));
  }
  onStatus(fps, hands) {
    const { width, height } = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    this.ctx.clearRect(0, 0, width, height);
    const rect = this.surface.getBoundingClientRect();
    for (const h2 of hands) {
      const x2 = (1 - h2.cursor.x) * rect.width;
      const y2 = h2.cursor.y * rect.height;
      this.ctx.beginPath();
      this.ctx.arc(x2 * dpr, y2 * dpr, (h2.pinching ? 14 : 9) * dpr, 0, Math.PI * 2);
      this.ctx.fillStyle = handColor(h2.handedness, h2.pinching);
      this.ctx.globalAlpha = 0.85;
      this.ctx.fill();
      this.ctx.globalAlpha = 1;
    }
    if (this.running && this.grabs.size === 0 && this.taps.size === 0) {
      this.status.textContent = `on \xB7 ${fps}fps`;
    }
  }
  flash(msg) {
    this.status.textContent = msg;
  }
  sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
  }
};
function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
function describeError(err) {
  if (err instanceof Error) return err.message || err.name || "Error";
  if (typeof err === "string") return err;
  if (typeof err === "number") return `code ${err}`;
  if (err && typeof err === "object") {
    const m2 = err.message;
    if (typeof m2 === "string" && m2) return m2;
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}
function injectStyles() {
  if (document.getElementById("cg-styles")) return;
  const css = `
  .cg-surface, .cg-canvas { position: fixed; inset: 0; pointer-events: none; }
  .cg-surface { z-index: ${Z2}; }
  .cg-canvas  { z-index: ${Z2 + 1}; width: 100vw; height: 100vh; }
  .cg-preview { transform: scaleX(-1); pointer-events: none; background: #000; }
  .cg-preview.cg-pip {
    position: fixed; right: 12px; bottom: 12px; width: 240px; height: 135px;
    object-fit: cover; border-radius: 8px; z-index: ${Z2 + 2};
    box-shadow: 0 4px 16px rgba(0,0,0,.5); opacity: 1;
  }
  .cg-preview.cg-full {
    position: fixed; inset: 0; width: 100vw; height: 100vh;
    object-fit: cover; opacity: .28; z-index: ${Z2};
  }
  .cg-ghost {
    position: fixed; left: 0; top: 0; transform: translate(-50%, -50%) scale(1.06);
    z-index: ${Z2 + 2}; pointer-events: none; opacity: .92;
    box-shadow: 0 8px 28px rgba(0,0,0,.55); border-radius: 8px;
    outline: 2px solid #38bdf8; outline-offset: -2px;
  }
  .cg-ghost.cg-armed { outline-color: #4ade80; box-shadow: 0 8px 28px rgba(74,222,128,.5); }
  .cg-dock {
    position: fixed; right: 12px; bottom: 156px; z-index: ${Z2 + 3};
    display: flex; align-items: center; gap: 8px; font: 12px/1 system-ui, sans-serif;
  }
  .cg-btn {
    padding: 6px 12px; border-radius: 6px; border: 1px solid #3a3a40;
    background: #1b1b1f; color: #e5e5e7; cursor: pointer;
  }
  .cg-btn-icon { padding: 6px 9px; }
  .cg-btn.on { background: #16331f; border-color: #2f6b41; color: #4ade80; }
  .cg-status { color: #9aa0a6; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-tab.cg-grabbed { opacity: .35; outline: 2px dashed #4ade80; outline-offset: -2px; }
  .cg-tap-armed { outline: 2px solid #4ade80 !important; outline-offset: 2px; box-shadow: 0 0 0 4px rgba(74,222,128,.25) !important; }
  .subagent-window.cg-win-grabbed, .ultracode-window.cg-win-grabbed {
    outline: 2px solid #4ade80 !important; outline-offset: -2px;
    box-shadow: 0 12px 48px rgba(74,222,128,.5) !important;
  }
  .cg-float {
    position: fixed; left: 0; top: 0; width: ${FLOAT_W}px; height: ${FLOAT_H}px;
    z-index: ${Z2}; display: flex; flex-direction: column; overflow: hidden;
    background: #0c0c0f; border-radius: 10px; outline: 2px solid #38bdf8;
    outline-offset: -2px; box-shadow: 0 10px 40px rgba(0,0,0,.6);
  }
  .cg-float.cg-float-grabbed { outline-color: #4ade80; box-shadow: 0 12px 48px rgba(74,222,128,.45); }
  .cg-float.cg-redock { outline-color: #fbbf24; box-shadow: 0 12px 48px rgba(251,191,36,.5); }
  .cg-float-bar {
    flex: 0 0 auto; padding: 4px 10px; font: 11px/1.6 system-ui, sans-serif;
    color: #cbd5e1; background: #15151a; border-bottom: 1px solid #2a2a30;
    user-select: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .cg-float-frame { flex: 1 1 auto; width: 100%; border: 0; background: #000; }
  `;
  const style = document.createElement("style");
  style.id = "cg-styles";
  style.textContent = css;
  document.head.append(style);
}
if (!window.__codemanGesture) {
  window.__codemanGesture = new GestureBridge();
}
