(function () {
  const stage = document.getElementById("stage");
  const frame = document.getElementById("frame");
  const list = document.getElementById("list");
  const crumb = document.getElementById("crumb");
  const byIndex = new Map();
  VISU.pages.forEach(function (page) {
    if (!byIndex.has(page.index)) byIndex.set(page.index, page);
  });

  if (!VISU.groups.DateTimeFormats) {
    VISU.groups.DateTimeFormats = {
      de: { "0": "%d.%m.%Y   %H:%M:%S", "1": "%H:%M:%S", "2": "%H:%M" },
      en: { "0": "%m.%d.%Y   %H:%M:%S", "1": "%H:%M:%S", "2": "%H:%M" }
    };
  }

  let lang = localStorage.getItem("opcg-lang") || "de";
  let startBild = Number(localStorage.getItem("opcg-start")) || 20;
  let pageIndex = 10;
  let history = [];
  let store = {};
  let slots = [null, null, null];
  const known = [];

  VISU.pages.forEach(function (page) {
    (page.layers || []).forEach(function (layer) {
      if (layer.st) known.push(layer.st);
      (layer.controls || []).forEach(function (control) {
        if (control.dp) known.push(control.dp);
        if (control.st) known.push(control.st);
        if (control.td) known.push(control.td);
        if (control.tid) known.push(control.tid);
      });
    });
  });

  function freshStore() {
    store = Object.assign({}, VISU.seed || {});
  }

  freshStore();
  let seenLang = null;

  function save() {
    localStorage.setItem("opcg-schulung-v1", JSON.stringify({ store: store, slots: slots }));
    localStorage.setItem("opcg-lang", lang);
    localStorage.setItem("opcg-start", String(startBild));
  }

  function get(dp) {
    if (!dp) return undefined;
    return store[dp];
  }

  const SGC = 1;
  const SG4_V2_20 = 2;
  const SG4_V2_30 = 3;

  function defaultVisible(dp) {
    if (/uiPxxxRT\[\d+\]/.test(dp)) return false;
    if (dp === "strPage45.uiLayerHandling") return false;
    const layer = /LayerHandling\[(\d+)\]/.exec(dp);
    if (layer) return Number(layer[1]) === 0;
    if (/KukLanRT\[\d+\]/.test(dp)) return false;
    if (/uiMainLayer\[\d+\]/.test(dp)) return false;
    if (/strPage24\.uiRuntime\[[1-9]\d*\]/.test(dp)) return false;
    return true;
  }

  function n(dp) {
    const value = get(dp);
    return value == null || value === "" ? 0 : Number(value);
  }
  function hw() { return n("iDWC_HW") || SGC; }
  function p(id) { return n("xP" + id + ".diValue"); }
  function r(name, index) { return n("strR." + name + "[" + index + "]"); }

  function grafikPage() {
    return { 0: 20, 1: 21, 2: 22, 3: 24, 4: 23 }[p(1020)] || 21;
  }

  function paintRows() {
    for (let i = 0; i < 8; i++) {
      const values = i < 3 ? slots[i] : null;
      const fn = values && values["xP1000.diValue"] != null ? values["xP1000.diValue"] : 0;
      const name = values && values["xPconf.P1010_txtWaageName"] ? values["xPconf.P1010_txtWaageName"] : "";
      store["ClientInfo.lServerFn[" + i + "]"] = fn;
      store["ClientInfo.strServerWaagenName[" + i + "]"] = name;
      store["strMainPage.lP3[" + i + "]"] = 0;
      store["strMainPage.lG1[" + i + "]"] = 0;
      store["ClientInfo.iCmdRuntime[" + i + "]"] = i < 3 ? AKTIV : INAKTIV;
      store["strMainPage.uiRun[" + i + "]"] = INAKTIV;
    }
  }

  function applySlot(index) {
    const values = slots[index];
    store = Object.assign({}, VISU.seed || {});
    ensurePlant();
    if (values) Object.assign(store, values);
    paintRows();
  }

  function loadSlot(index, text) {
    if (index < 0 || index > 2 || !text) return;
    const values = {};
    collectCsv(text, values);
    slots[index] = values;
    paintRows();
    save();
    render();
  }

  function openScale() {
    const index = n("ClientInfo.iNrDwc");
    if (index >= 0 && index < 3) applySlot(index);
    const start = Number(get("fromX20.pzd.iStartseite"));
    gotoIndex(start > 0 && byIndex.has(start) ? start : grafikPage());
  }

  function skipNorm(nr) {
    const art = p(1020);
    if (nr === 20 && art !== 0) return true;
    if (nr === 21 && art !== 1) return true;
    if (nr === 22 && art !== 2) return true;
    if (nr === 24 && art !== 3) return true;
    if (nr === 23 && art !== 4) return true;
    if (nr === 28 && !p(1501) && !p(1502) && !p(1503) && !p(1504) && !p(1505) && !p(4205) && p(1000) !== -1) return true;
    if (nr === 36 && p(4100) === 0) return true;
    if (nr === 41 && (((p(4510) === 0 && p(4511) === 0) && hw() === SGC) || (p(4510) === 0 && hw() >= SG4_V2_20))) return true;
    return false;
  }

  function skipPar(nr) {
    const h = hw();
    const sgc = h === SGC;
    const sg4 = h >= SG4_V2_20;
    const art = p(1020);
    const za = [[1501, 1510, 1512, 1518], [1502, 1520, 1522, 1528], [1503, 1530, 1532, 1538], [1504, 1540, 1542, 1548], [1505, 1550, 1552, 1558]];
    for (let i = 0; i < za.length; i++) {
      if (za[i].indexOf(nr) >= 0 && ((p(za[i][0]) === 0 && sgc) || sg4)) return true;
    }
    if (nr === 1561 && !p(1501) && !p(1502) && !p(1503) && !p(1504) && !p(1505)) return true;
    const xd = [[1501, 1600, 1607, 1614], [1502, 1620, 1627, 1634], [1503, 1640, 1647, 1654], [1504, 1660, 1667, 1674], [1505, 1680, 1687, 1694], [1506, 1700, 1707, 1714], [1507, 1720, 1727, 1734]];
    for (let i = 0; i < xd.length; i++) {
      if (xd[i].indexOf(nr) >= 0 && ((p(xd[i][0]) === 0 && sg4) || sgc)) return true;
    }
    if (sgc && (nr === 1676 || nr === 1740 || nr === 1750 || nr === 4180 || nr === 4400 || nr === 4720 || nr === 4730)) return true;
    if ((art === 0 || art === 1 || art === 2 || art === 4) && (nr === 1900 || nr === 1930 || nr === 2900)) return true;
    if (art === 3 && ((sgc && nr === 1930) || nr === 4200)) return true;
    if (h <= SG4_V2_20 && (nr === 2500 || nr === 2510)) return true;
    if (r("R9500_sHwAI1744", 0) === 0 && (nr === 5000 || nr === 5007)) return true;
    if (r("R9500_sHwAI1744", 1) === 0 && n("bAIA744Aktiv[0]") === 0 && (nr === 5010 || nr === 5017)) return true;
    if (r("R9500_sHwAI1744", 2) === 0 && (nr === 5020 || nr === 5027)) return true;
    if (r("R9500_sHwAI1744", 3) === 0 && n("bAIA744Aktiv[1]") === 0 && (nr === 5030 || nr === 5037)) return true;
    if (r("R9500_sHwAI1744", 4) === 0 && (nr === 5040 || nr === 5047)) return true;
    if (r("R9500_sHwAI1744", 5) === 0 && n("bAIA744Aktiv[2]") === 0 && (nr === 5050 || nr === 5057)) return true;
    if (r("R9520_sHwAI2622", 0) === 0 && !n("bDWC8Aktiv") && nr === 5200) return true;
    if (r("R9520_sHwAI2622", 0) === 0 && nr === 5210) return true;
    if (r("R9520_sHwAI2622", 1) === 0 && (nr === 5220 || nr === 5230)) return true;
    if (r("R9550_sHwAO4622", 0) === 0 && !n("bDWC8Aktiv") && nr === 5500) return true;
    if (r("R9550_sHwAO4622", 0) === 0 && (nr === 5510 || nr === 5520 || nr === 5530)) return true;
    if (r("R9550_sHwAO4622", 1) === 0 && (nr === 5540 || nr === 5550 || nr === 5560 || nr === 5570)) return true;
    if (r("R9580_sHwCS1033", 0) === 0 && (nr === 5800 || nr === 5810)) return true;
    if (r("R9580_sHwCS1033", 1) === 0 && (nr === 5820 || nr === 5830)) return true;
    const di = [[0, 6010, 6110], [1, 6020, 6120], [2, 6030, 6130], [3, 6040, 6140], [4, 6050, 6150]];
    for (let i = 0; i < di.length; i++) {
      if (r("R9600_sHwDI4371", di[i][0]) === 0 && (nr === di[i][1] || nr === di[i][2])) return true;
    }
    if ((sgc || r("R9600_sHwDI4371", 5) === 0) && (nr === 6060 || nr === 6160)) return true;
    if ((sgc || r("R9600_sHwDI4371", 6) === 0) && (nr === 6070 || nr === 6170)) return true;
    const dout = [[0, 6410, 6510], [1, 6420, 6520], [2, 6430, 6530]];
    for (let i = 0; i < dout.length; i++) {
      if (r("R9640_sHwDO6322", dout[i][0]) === 0 && (nr === dout[i][1] || nr === dout[i][2])) return true;
    }
    if ((r("R9700_sBusVersion", 0) === 0 || p(7010) === 128) && (nr === 7200 || nr === 7208 || nr === 7400 || nr === 7408)) return true;
    if (nr === 7600 && (n("ClientInfo.uiSG[0]") || h) <= SG4_V2_20) return true;
    if (nr === 7700 && !(p(7400) === 51 && p(7401) === 45 && p(7402) === 75 && p(7403) === 76 && p(7404) === 77 && p(7405) === 78 && p(7406) === 79 && p(7407) === 80)) return true;
    return false;
  }

  function arrowSkips(index) {
    if (index >= 1000) return skipPar(index);
    if (index === 0 || index === 5) return true;
    if (index <= 43) return skipNorm(index);
    return false;
  }

  function plantDefault(dp, value) {
    if (!Object.prototype.hasOwnProperty.call(store, dp)) store[dp] = value;
  }

  function ensurePlant() {
    plantDefault("iDWC_HW", SGC);
    plantDefault("xP1020.diValue", 0);
    plantDefault("xP1501.diValue", 1);
    plantDefault("xP4100.diValue", 0);
    plantDefault("strR.R9500_sHwAI1744[0]", 1);
    plantDefault("strR.R9520_sHwAI2622[0]", 1);
    plantDefault("strR.R9550_sHwAO4622[0]", 1);
    plantDefault("strR.R9600_sHwDI4371[0]", 1);
    plantDefault("strR.R9640_sHwDO6322[0]", 1);
    plantDefault("strR.R9700_sBusVersion[0]", 1);
    for (let i = 0; i < 7; i++) plantDefault("strPage45.uiPxxxRT[" + i + "]", 1);
    plantDefault("strPage45.uiLayerHandling", 1);
    startBild = grafikPage();
  }

  const AKTIV = 0;
  const INAKTIV = 1;

  function vis(dp, on) {
    store[dp] = on ? AKTIV : INAKTIV;
  }

  function applyGrafik() {
    const speed = n("fromX20.pzd.lSpeedPr");
    vis("Visu.VisuCtrl.strAnzeige.uiBandLauf", speed !== 0);
    vis("Visu.VisuCtrl.strAnzeige.uiBandStand", speed === 0);
    const dosierung = p(3000);
    if (dosierung !== 0) {
      vis("Visu.VisuCtrl.strAnzeige.uiZuteilerLauf", false);
      vis("Visu.VisuCtrl.strAnzeige.uiZuteilerStand", true);
      vis("Visu.VisuCtrl.strAnzeige.uiZT_Visu", dosierung === 1);
      vis("Visu.VisuCtrl.strPage26.uiVB_aktiv", dosierung === 2);
    } else {
      vis("Visu.VisuCtrl.strAnzeige.uiZuteilerLauf", false);
      vis("Visu.VisuCtrl.strAnzeige.uiZuteilerStand", false);
      vis("Visu.VisuCtrl.strAnzeige.uiZT_Visu", false);
      vis("Visu.VisuCtrl.strPage26.uiVB_aktiv", false);
    }
    const keinSoll = p(3010) === 0 && p(3011) === 0 && p(3012) === 0;
    vis("Visu.VisuCtrl.strAnzeige.uiSW_Balken", !(keinSoll || (n("bDWC8Aktiv") !== 0 && dosierung === 0)));
    store["Visu.VisuCtrl.iBetriebszustand"] = 1;
    vis("Visu.VisuCtrl.strGrafikbild.uiWarning", false);
    vis("Visu.VisuCtrl.strGrafikbild.uiGreen", false);
    const simg = p(4000) !== 0;
    const simv = p(4010) !== 0 || simg;
    vis("Visu.VisuCtrl.strPage25.uiSimg", simg);
    vis("Visu.VisuCtrl.strPage25.uiSimv", simv);
    vis("Visu.VisuCtrl.strGrafikbild.uiSim_aktiv", simg || simv);
    const charge = n("uiChargeAktiv") === 1;
    vis("Visu.VisuCtrl.uiGBChar", charge);
    vis("Visu.VisuCtrl.uiGBSTD", !charge);
    vis("Visu.VisuCtrl.strAnzeige.uiRevAktiv", false);
    const auflage = [1501, 1502, 1503, 1504, 1505].some(function (id) { return p(id) === 15; })
      || [6001, 6002, 6003].some(function (id) { return p(id) === 62 || p(id) === 63; })
      || [6400, 6401, 6410, 6411, 6412, 6413, 6414, 6415].some(function (id) { return p(id) === 71; });
    vis("Visu.VisuCtrl.strTW_Auflage.Runtime", auflage);
    vis("Visu.VisuCtrl.strGrafikbild.uiAW_Status", false);
    vis("Visu.VisuCtrl.strGrafikbild.uiRuntimeSv_abs", false);
    vis("Visu.VisuCtrl.strGrafikbild.uiLayerHandling[0]", p(4850) !== 0);
    vis("Visu.VisuCtrl.uiRuntimeEich", p(1055) !== 0);
    applyHeader();
    applyBusLayers();
    applyFieldbus();
    applyStatus();
    enterIoPages();
    applyPictures();
    applyLanguage();
  }

  function languageCode(value) {
    if (value == null || value === "") return 0;
    if (typeof value === "number" && !isNaN(value)) return value;
    const text = String(value).trim();
    if (/^[+-]?\d+(?:[.,]\d+)?$/.test(text.replace(/\s+/g, ""))) return Number(text.replace(/\s+/g, "").replace(",", "."));
    const lead = /^(\d+)\s*:/.exec(text);
    if (lead) return Number(lead[1]);
    const group = VISU.groups && VISU.groups.T11070_Language;
    const tables = group ? [group.de, group.en] : [];
    for (let t = 0; t < tables.length; t++) {
      const table = tables[t] || {};
      const keys = Object.keys(table);
      for (let i = 0; i < keys.length; i++) {
        if (String(table[keys[i]] || "").trim() === text) return Number(keys[i]);
      }
    }
    return 0;
  }

  function parameterLang() {
    const code = languageCode(get("xP1070.diValue"));
    if (get("xP1070.diValue") !== code) store["xP1070.diValue"] = code;
    return code;
  }

  function applyLanguage() {
    if (pageIndex === 7 || pageIndex === 15) return;
    const configured = parameterLang();
    const code = { 0: "en", 1: "de" };
    if (seenLang !== configured) {
      store["Visu.VisuCtrl.uiLangStep"] = 0;
      seenLang = configured;
    }
    if (configured) {
      vis("Visu.VisuCtrl.uiLangRT", true);
      if (n("Visu.VisuCtrl.uiLangStep") === 1) {
        store.diLangNew = 0;
        store["Visu.VisuCtrl.uiLangIndex"] = configured;
        lang = "en";
      } else {
        store.diLangNew = configured;
        store["Visu.VisuCtrl.uiLangIndex"] = 0;
        lang = code[configured] || "de";
      }
    } else {
      vis("Visu.VisuCtrl.uiLangRT", false);
      store["Visu.VisuCtrl.uiLangIndex"] = 255;
      store.diLangNew = 0;
      lang = "en";
    }
    const box = document.getElementById("lang");
    if (box && (lang === "de" || lang === "en") && box.value !== lang) box.value = lang;
  }

  const HW_SLOTS = {
    R9500: ["xPconf.P9500_txtHwAI1744", "strR.R9500_sHwAI1744"],
    R9510: ["xPconf.P9510_txtHwDS1319", "strR.R9510_sHwDS1319"],
    R9520: ["xPconf.P9520_txtHwAI2622", "strR.R9520_sHwAI2622"],
    R9550: ["xPconf.P9550_txtHwAO4622", "strR.R9550_sHwAO4622"],
    R9580: ["xPconf.P9580_txtHwCS1033", "strR.R9580_sHwCS1033"],
    R9600: ["xPconf.P9600_txtHwDI4371", "strR.R9600_sHwDI4371"],
    R9640: ["xPconf.P9640_txtHwDO6322", "strR.R9640_sHwDO6322"]
  };

  function parseSlots(text) {
    return String(text).trim().split("_").map(function (part) {
      const token = part.trim();
      if (!token || token === "--") return 0;
      const hex = /^0x([0-9a-f]+)$/i.exec(token);
      if (hex) return parseInt(hex[1], 16);
      const num = Number(token);
      return isNaN(num) ? 0 : num;
    });
  }

  function writeSlots(arrayName, text, target) {
    const dest = target || store;
    for (let i = 0; i < 8; i++) dest[arrayName + "[" + i + "]"] = 0;
    parseSlots(text).forEach(function (code, index) {
      dest[arrayName + "[" + index + "]"] = code;
    });
  }

  function anyHw(name, count) {
    for (let i = 0; i < count; i++) if (r(name, i) !== 0) return true;
    return false;
  }

  function applyHardware() {
    Object.keys(HW_SLOTS).forEach(function (key) {
      const text = get(HW_SLOTS[key][0]);
      if (text == null || text === "" || typeof text === "number") return;
      if (String(text).indexOf("_") < 0 && String(text).indexOf("--") < 0) return;
      writeSlots(HW_SLOTS[key][1], text);
    });
  }

  function applyFieldbus() {
    const bus = n("fromX20.pzd.iBusTyp");
    const kind = p(7002);
    const module = kind === 1 || kind === 2 || kind === 3 || bus === 10 || bus === 20 || bus === 30 || bus === 40;
    vis("Visu.VisuCtrl.strGrafikbild.uiFB_ModulErr", !module);
    vis("Visu.VisuCtrl.strGrafikbild.uiBusOk", module);
    let index = 0;
    if (kind === 1) index = 5;
    else if (kind === 2) index = 6;
    else if (kind === 3) index = 7;
    else if (p(7010) === 128 && r("R9700_sBusVersion", 0) === 10) index = 0;
    else if (bus === 10) index = 1;
    else if (bus === 20) index = 2;
    else if (bus === 30) index = 3;
    else if (bus === 40) index = 4;
    store["Visu.VisuCtrl.iFBIndex"] = index;
  }

  function applyStatus() {
    applyHardware();
    vis("Visu.VisuCtrl.strPage40.uiDI10_13", anyHw("R9600_sHwDI4371", 8));
    vis("Visu.VisuCtrl.strPage40.uiAI00_RT", anyHw("R9520_sHwAI2622", 4));
    vis("Visu.VisuCtrl.strPage40.uiDO10_15", anyHw("R9640_sHwDO6322", 4));
    vis("Visu.VisuCtrl.strPage40.strIO_Check.uiDO20_RT", r("R9640_sHwDO6322", 1) !== 0);
    vis("Visu.VisuCtrl.strPage40.strIO_Check.uiDO30_RT", r("R9640_sHwDO6322", 2) !== 0);
    vis("Visu.VisuCtrl.strPage40.strIO_Check.uiAO00_RT", r("R9550_sHwAO4622", 0) !== 0 || r("R9550_sHwAO4622", 1) === 115);
    vis("Visu.VisuCtrl.strPage40.strIO_Check.uiAO10_RT", r("R9550_sHwAO4622", 1) !== 0);
    const bus = n("fromX20.pzd.iBusTyp");
    vis("Visu.VisuCtrl.strPage40.uiBus_RT", !(p(7010) === 128 && (bus === 10 || bus === 40)));
    vis("Visu.VisuCtrl.strPage40.uiSetTime", hw() !== SGC);
    vis("Visu.VisuCtrl.strPage40.uiMM_RT", r("R9580_sHwCS1033", 0) !== 0);
    vis("Visu.VisuCtrl.strPage40.strDEV.uiTaraButtonRT", p(1020) !== 2 && p(1020) !== 3);
  }

  function showPage40(index) {
    for (let i = 0; i < 9; i++) store["Visu.VisuCtrl.strPage40.uiLayerRT[" + i + "]"] = i === index ? AKTIV : INAKTIV;
  }

  function page40HasLayer() {
    for (let i = 0; i < 9; i++) {
      const key = "Visu.VisuCtrl.strPage40.uiLayerRT[" + i + "]";
      if (Object.prototype.hasOwnProperty.call(store, key) && Number(store[key]) === 0) return true;
    }
    return false;
  }

  function initPage40() {
    const dwc8 = n("bDWC8Aktiv") !== 0;
    for (let i = 0; i < 5; i++) {
      vis("Visu.VisuCtrl.strPage40.strNav.uiRT[" + i + "]", false);
      store["Visu.VisuCtrl.strPage40.strNav.bAktiv[" + i + "]"] = 1;
    }
    store["Visu.VisuCtrl.strPage40.strNav.txtIndex[0]"] = dwc8 ? 1 : 0;
    vis("Visu.VisuCtrl.strPage40.strNav.uiRT[0]", true);
    store["Visu.VisuCtrl.strPage40.strNav.bAktiv[0]"] = 0;
    let count = 1;
    if (!dwc8) {
      store["Visu.VisuCtrl.strPage40.strNav.txtIndex[1]"] = 4;
      vis("Visu.VisuCtrl.strPage40.strNav.uiRT[1]", true);
      count = 2;
    }
    if (!dwc8 && p(1000) === -1) {
      store["Visu.VisuCtrl.strPage40.strNav.txtIndex[" + count + "]"] = 2;
      vis("Visu.VisuCtrl.strPage40.strNav.uiRT[" + count + "]", true);
    }
    showPage40(dwc8 ? 1 : 0);
  }

  function page40Nav(cmd) {
    const text = n("Visu.VisuCtrl.strPage40.strNav.txtIndex[" + (Number(cmd) - 1) + "]");
    const layer = { 0: 0, 1: 1, 2: 2, 4: 8 }[text];
    if (layer == null) return false;
    showPage40(layer);
    for (let i = 0; i < 5; i++) store["Visu.VisuCtrl.strPage40.strNav.bAktiv[" + i + "]"] = i === Number(cmd) - 1 ? 0 : 1;
    render();
    save();
    return true;
  }

  function page40Force(cmd) {
    const layer = { 1: 3, 2: 6, 3: 7, 10: 3, 11: 4, 12: 5 }[Number(cmd)];
    if (layer == null) { render(); save(); return false; }
    showPage40(layer);
    for (let i = 0; i < 5; i++) store["Visu.VisuCtrl.strPage40.strNav.bAktiv[" + i + "]"] = 1;
    render();
    save();
    return true;
  }

  function armed(key) {
    return Object.prototype.hasOwnProperty.call(store, key);
  }

  function showLayer(base, count, index) {
    for (let i = 0; i < count; i++) store[base + "[" + i + "]"] = i === index ? AKTIV : INAKTIV;
  }

  function showNamed(names, index) {
    names.forEach(function (name, i) { store[name] = i === index ? AKTIV : INAKTIV; });
  }

  function openLayer(base, count, index, silent) {
    if (index == null) return false;
    showLayer(base, count, index);
    if (!silent) { render(); save(); }
    return true;
  }

  function initPage50() {
    showLayer("Visu.VisuCtrl.strPage50.uiLayerRuntime", 6, 0);
    const show = [
      p(5019) === 0 && (r("R9500_sHwAI1744", 1) !== 0 || n("bAIA744Aktiv[0]") !== 0),
      p(5029) === 0 && r("R9500_sHwAI1744", 2) !== 0,
      p(5039) === 0 && (r("R9500_sHwAI1744", 3) !== 0 || n("bAIA744Aktiv[1]") !== 0),
      p(5049) === 0 && r("R9500_sHwAI1744", 4) !== 0,
      p(5059) === 0 && (r("R9500_sHwAI1744", 5) !== 0 || n("bAIA744Aktiv[2]") !== 0)
    ];
    show.forEach(function (on, index) {
      store["Visu.VisuCtrl.strPage50.uiTaraButtonRuntime[" + index + "]"] = on ? AKTIV : INAKTIV;
    });
  }

  function page50(cmd) {
    const layer = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 10: 0, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0 }[Number(cmd)];
    return openLayer("Visu.VisuCtrl.strPage50.uiLayerRuntime", 6, layer);
  }

  function page52(cmd, silent) {
    const names = ["uiAI00", "uiAI10", "uiAI20", "uiAI30"];
    const index = { 1: 0, 10: 1, 20: 2, 30: 3 }[Number(cmd)];
    const chosen = index == null ? 0 : index;
    showNamed(names.map(function (name) { return "Visu.VisuCtrl.strPage52." + name; }), chosen);
    store["Visu.VisuCtrl.strPage52.sAiNr"] = [1, 10, 20, 30][chosen];
    const present = [0, 1, 2, 3].map(function (i) { return r("R9520_sHwAI2622", i) !== 0; });
    store["Visu.VisuCtrl.strPage52.uiButtonAi00"] = present[0] && present[1] ? AKTIV : INAKTIV;
    store["Visu.VisuCtrl.strPage52.uiButtonAi10"] = present[0] && present[1] ? AKTIV : INAKTIV;
    store["Visu.VisuCtrl.strPage52.uiButtonAi20"] = present[0] && present[2] ? AKTIV : INAKTIV;
    store["Visu.VisuCtrl.strPage52.uiButtonAi30"] = present[0] && present[3] ? AKTIV : INAKTIV;
    if (!silent) { render(); save(); }
    return true;
  }

  function initPage56() {
    const slot1 = r("R9550_sHwAO4622", 1);
    const names = ["uiA000", "uiA010", "uiAO20", "uiAO30"].map(function (name) { return "Visu.VisuCtrl.strPage56." + name; });
    showNamed(names, slot1 === 115 ? 1 : 0);
    const present = [0, 1, 2, 3].map(function (i) { return r("R9550_sHwAO4622", i) !== 0; });
    store["Visu.VisuCtrl.strPage56.uiButtonAO00"] = present[0] && present[1] && slot1 !== 115 ? AKTIV : INAKTIV;
    store["Visu.VisuCtrl.strPage56.uiButtonAO10"] = present[0] && present[1] ? AKTIV : INAKTIV;
    store["Visu.VisuCtrl.strPage56.uiButtonAO20"] = present[0] && present[2] ? AKTIV : INAKTIV;
    store["Visu.VisuCtrl.strPage56.uiButtonAO30"] = present[0] && present[3] ? AKTIV : INAKTIV;
  }

  function page56(cmd) {
    const names = ["uiA000", "uiA010", "uiAO20", "uiAO30"].map(function (name) { return "Visu.VisuCtrl.strPage56." + name; });
    const index = { 1: 0, 10: 1, 20: 2, 30: 3 }[Number(cmd)];
    if (index == null) return false;
    showNamed(names, index);
    render();
    save();
    return true;
  }

  function initPage61() {
    showLayer("Visu.VisuCtrl.strPage61.uiLayerHandling", 10, 0);
    for (let i = 0; i < 7; i++) store["Visu.VisuCtrl.strPage61.uiRuntimeButton[" + i + "]"] = INAKTIV;
    if (r("R9600_sHwDI4371", 1)) {
      store["Visu.VisuCtrl.strPage61.uiRuntimeButton[0]"] = AKTIV;
      store["Visu.VisuCtrl.strPage61.uiRuntimeButton[1]"] = AKTIV;
    }
    [2, 3, 4, 5, 6].forEach(function (slot, index) {
      if (r("R9600_sHwDI4371", slot)) store["Visu.VisuCtrl.strPage61.uiRuntimeButton[" + (index + 2) + "]"] = AKTIV;
    });
  }

  function page61(cmd) {
    const layer = { 10: 0, 20: 1, 30: 2, 40: 3, 50: 4, 60: 5, 70: 6 }[Number(cmd)];
    return openLayer("Visu.VisuCtrl.strPage61.uiLayerHandling", 10, layer);
  }

  function initPage64() {
    showLayer("Visu.VisuCtrl.strPage64.uiRuntimeLayer", 3, 0);
    store["Visu.VisuCtrl.strPage64.uiRuntimeButton[0]"] = r("R9640_sHwDO6322", 0) && r("R9640_sHwDO6322", 1) ? AKTIV : INAKTIV;
    store["Visu.VisuCtrl.strPage64.uiRuntimeButton[1]"] = r("R9640_sHwDO6322", 2) ? AKTIV : INAKTIV;
  }

  function page64(cmd) {
    const layer = { 10: 0, 20: 1, 30: 2 }[Number(cmd)];
    return openLayer("Visu.VisuCtrl.strPage64.uiRuntimeLayer", 3, layer);
  }

  function initPage70() {
    showLayer("Visu.VisuCtrl.strPage70.uiRuntimeLayer", 6, 0);
    store["Visu.VisuCtrl.strPage70.uiButtonRuntime"] = r("R9580_sHwCS1033", 1) ? AKTIV : INAKTIV;
  }

  function page70(cmd) {
    const layer = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 }[Number(cmd)];
    return openLayer("Visu.VisuCtrl.strPage70.uiRuntimeLayer", 6, layer);
  }

  function page76(cmd, silent) {
    const layer = { 1: 0, 2: 1, 3: 2, 10: 3, 11: 4, 12: 5, 20: 6, 21: 7, 22: 8, 23: 9, 24: 10, 25: 11, 26: 14, 27: 15, 28: 16, 50: 0, 51: 3, 52: 6, 53: 9, 54: 14, 100: 12, 101: 0, 201: 12, 202: 13 }[Number(cmd)];
    if (Number(cmd) === 201) store["Visu.VisuCtrl.strPage76.iMainLayerButtonLock"] = 0;
    if (Number(cmd) === 202) store["Visu.VisuCtrl.strPage76.iMainLayerButtonLock"] = 1;
    return openLayer("Visu.VisuCtrl.strPage76.uiRuntimeLayer", 20, layer, silent);
  }

  function page78(cmd, silent) {
    const layer = { 1: 1, 2: 2, 3: 3, 10: 4, 11: 5, 12: 6, 13: 14, 14: 15, 15: 16, 20: 7, 21: 8, 22: 9, 30: 10, 31: 11, 32: 12, 33: 17, 34: 18, 35: 19, 50: 1, 51: 4, 52: 14, 53: 7, 54: 10, 55: 17, 100: 0, 101: 1, 102: 7, 201: 0, 202: 13 }[Number(cmd)];
    if (Number(cmd) === 201) store["Visu.VisuCtrl.strPage78.iMainLayerButtonLock"] = 0;
    if (Number(cmd) === 202) store["Visu.VisuCtrl.strPage78.iMainLayerButtonLock"] = 1;
    return openLayer("Visu.VisuCtrl.strPage78.uiRuntimeLayer", 20, layer, silent);
  }

  function initPage8() {
    showLayer("Visu.VisuCtrl.strPage08.uiLayerHandling", 4, n("Visu.VisuCtrl.strPage40.uiLastPage") === 1 ? 2 : 0);
  }

  function page8(cmd) {
    const layer = { 1: 3, 2: 2, 3: 1 }[Number(cmd)];
    return openLayer("Visu.VisuCtrl.strPage08.uiLayerHandling", 4, layer);
  }

  function initPage29() {
    showLayer("Visu.VisuCtrl.strPage29.uiLayerHandling", 2, 0);
    store["Visu.VisuCtrl.strPage29.uiNavButtonRuntime"] = p(1055) ? AKTIV : INAKTIV;
  }

  function page29(cmd) {
    const layer = { 1: 0, 2: 1 }[Number(cmd)];
    return openLayer("Visu.VisuCtrl.strPage29.uiLayerHandling", 2, layer);
  }

  function enterIoPages(force) {
    if (pageIndex === 40 && (force || !page40HasLayer())) initPage40();
    if (pageIndex === 50 && (force || !armed("Visu.VisuCtrl.strPage50.uiLayerRuntime[0]"))) initPage50();
    if (pageIndex === 52 && (force || !armed("Visu.VisuCtrl.strPage52.uiAI00"))) page52(1, true);
    if (pageIndex === 56 && (force || !armed("Visu.VisuCtrl.strPage56.uiA000"))) initPage56();
    if (pageIndex === 61 && (force || !armed("Visu.VisuCtrl.strPage61.uiLayerHandling[0]"))) initPage61();
    if (pageIndex === 64 && (force || !armed("Visu.VisuCtrl.strPage64.uiRuntimeLayer[0]"))) initPage64();
    if (pageIndex === 70 && (force || !armed("Visu.VisuCtrl.strPage70.uiRuntimeLayer[0]"))) initPage70();
    if (pageIndex === 76 && (force || !armed("Visu.VisuCtrl.strPage76.uiRuntimeLayer[12]"))) page76(100, true);
    if (pageIndex === 78 && (force || !armed("Visu.VisuCtrl.strPage78.uiRuntimeLayer[0]"))) page78(100, true);
    if (pageIndex === 8 && (force || !armed("Visu.VisuCtrl.strPage08.uiLayerHandling[0]"))) initPage8();
    if (pageIndex === 29 && (force || !armed("Visu.VisuCtrl.strPage29.uiLayerHandling[0]"))) initPage29();
  }

  function busCode(value) {
    if (value === 10 || value === 20 || value === 30 || value === 40) return value;
    const text = String(value == null ? "" : value).toLowerCase();
    if (text.indexOf("if103e") >= 0 || text.indexOf("profinet") >= 0) return 20;
    if (text.indexOf("if10d3") >= 0 || text.indexOf("ethernet") >= 0) return 30;
    if (text.indexOf("if1053") >= 0 || text.indexOf("devicenet") >= 0) return 40;
    if (text.indexOf("if1063") >= 0 || text.indexOf("profibus") >= 0) return 10;
    return 0;
  }

  function applyBusLayers() {
    const fromText = busCode(get("xPconf.P9700_txtBusType"));
    if (fromText && !n("fromX20.pzd.iBusTyp")) store["fromX20.pzd.iBusTyp"] = fromText;
    const bus = n("fromX20.pzd.iBusTyp");
    const show = { 10: 0, 20: 1, 30: 2, 40: 3 }[bus];
    for (let i = 0; i < 5; i++) {
      store["Visu.VisuCtrl.strPage7010.uiRuntimeLayer[" + i + "]"] = i === show ? AKTIV : INAKTIV;
    }
    vis("Visu.VisuCtrl.strPage7010.uiRuntimeBaud", bus === 40);
    vis("Visu.VisuCtrl.strPage7010.uiRuntimeBusAdr", bus === 10 || bus === 40);
  }

  function splitBusBytes(source, dest) {
    if (!Object.prototype.hasOwnProperty.call(store, source)) return;
    let value = n(source) >>> 0;
    for (let i = 3; i >= 0; i--) {
      store[dest + "[" + i + "]"] = value & 255;
      value >>>= 8;
    }
  }

  function enterPage7010() {
    applyBusLayers();
    const bus = n("fromX20.pzd.iBusTyp");
    if (bus !== 10 && bus !== 40) store["xP7010.diValue"] = 126;
    if (bus === 30) {
      splitBusBytes("xP7025.diValue", "Visu.VisuCtrl.strPage7010.uiIpAdresse");
      splitBusBytes("xP7026.diValue", "Visu.VisuCtrl.strPage7010.uiSubMask");
    }
  }

  function applyHeader() {
    if (Object.prototype.hasOwnProperty.call(store, "xP1000.diValue")) {
      store["fromX20.pzd.lFnKukla"] = store["xP1000.diValue"];
    }
    const nameKey = "xPconf.P1010_txtWaageName";
    if (Object.prototype.hasOwnProperty.call(store, nameKey) && store[nameKey] != null && store[nameKey] !== "") {
      store["fromX20.pzd.txtScaleName"] = store[nameKey];
    }
    const panel = n("Visu.VisuCtrl.iBetriebsart") === 0 && p(3020) === 0 && n("bDWC8Aktiv") === 0;
    const driveOn = (n("fromX20.pzd.ulStatRel1") & 0x2000) !== 0;
    vis("Visu.VisuCtrl.uiStartButton", panel && !driveOn);
    vis("Visu.VisuCtrl.uiStopButton", panel && driveOn);
  }

  function applyPictures() {
    const run = "Visu.VisuCtrl.strPage24.uiRuntime";
    for (let i = 0; i < 4; i++) store[run + "[" + i + "]"] = i === 0 ? AKTIV : INAKTIV;
    const belt = p(4100);
    vis("Visu.VisuCtrl.strPage36.uiLayZeit", belt === 1);
    vis("Visu.VisuCtrl.strPage36.uiLay2P", belt === 2);
    vis("Visu.VisuCtrl.strPage36.uiLayEl", belt === 3);
    const ddw = p(1020) === 3;
    vis("Visu.VisuCtrl.strPage41.uiDDW_aktiv", ddw);
    vis("Visu.VisuCtrl.strPage41.uiDBW_aktiv", !ddw);
    const main = "Visu.VisuCtrl.strPage28.uiMainLayer";
    for (let i = 0; i <= 28; i++) store[main + "[" + i + "]"] = INAKTIV;
    const za = [1501, 1502, 1503, 1504, 1505, 1506, 1507];
    const zaIs = function (code) { return za.some(function (id) { return p(id) === code; }); };
    let layer = null;
    if (p(3064)) layer = 4;
    else if (hw() === SGC && [1501, 1502, 1503, 1504, 1505].some(function (id) { return p(id) !== 0; })) layer = 5;
    else if (hw() !== SGC && [1501, 1502, 1503, 1504, 1505].some(function (id) { return p(id) !== 0; })) layer = 19;
    else if (hw() !== SGC && (p(1506) || p(1507))) layer = 20;
    else if (p(4300) && p(4205)) layer = 24;
    else if (p(4205) === 4 && p(5000) === 2) layer = 1;
    else if (p(4205) !== 0) layer = p(4210) && p(4215) ? 3 : 2;
    else if (belt === 1) layer = 6;
    else if (belt === 2) layer = 7;
    else if (belt === 3) layer = 8;
    else if (p(4140)) layer = 10;
    else if (p(1055)) layer = 11;
    else if (zaIs(18) || zaIs(19)) layer = 21;
    else if (p(2500) || p(2510)) layer = 23;
    else if (p(4720)) layer = 25;
    else if (p(4730)) layer = 26;
    else if (p(4770)) layer = 27;
    else if (p(4780)) layer = 28;
    if (layer != null) store[main + "[" + layer + "]"] = AKTIV;
    for (let i = 0; i < 5; i++) {
      vis("Visu.VisuCtrl.strPage28.strZa.uiZaCover[" + i + "]", !(p(1501 + i) !== 0 && hw() === SGC));
    }
  }

  function parSelect() {
    const art = p(1020);
    store["strPage45.uiParSelect"] = art === 3 ? 1 : art === 4 ? 2 : art === 2 ? 3 : 0;
  }

  function groupButtons(which) {
    const buttons = [];
    function add() {
      for (let i = 0; i < arguments.length; i++) {
        if (buttons.indexOf(arguments[i]) < 0) buttons.push(arguments[i]);
      }
    }
    if (which === 0) {
      for (let i = 1; i <= 7; i++) if (p(1500 + i)) add(i + 1, 9, 10);
      if (p(1020) === 3) add(11);
    } else if (which === 1) {
      if (p(1020) === 3) add(5);
      if (hw() >= SG4_V2_30 && n("bBW_aktiv") === 0) add(4);
    } else if (which === 4) {
      if (r("R9520_sHwAI2622", 0) || n("bDWC8Aktiv")) add(2);
      if (r("R9520_sHwAI2622", 1)) add(3);
      if (r("R9550_sHwAO4622", 0) || n("bDWC8Aktiv")) add(4);
      if (r("R9550_sHwAO4622", 1)) add(5);
      if (r("R9580_sHwCS1033", 0)) add(6);
      if (r("R9580_sHwCS1033", 1)) add(7);
    } else if (which === 5) {
      for (let i = 0; i < 7; i++) if (r("R9600_sHwDI4371", i)) add(i + 1);
      for (let i = 0; i < 3; i++) if (r("R9640_sHwDO6322", i)) add(i + 8);
    } else if (which === 6) {
      if ((n("ClientInfo.uiSG[0]") || hw()) > SG4_V2_20) add(3);
    }
    return buttons;
  }

  let keep45 = false;

  function showGroup(which) {
    applyShow("strPage45.uiPxxxRT", [which]);
    applyShow("strPage45.uiButtonLayer", groupButtons(which));
  }

  function shown(dp) {
    if (!dp) return true;
    if (Object.prototype.hasOwnProperty.call(store, dp)) return Number(store[dp]) === 0;
    return defaultVisible(dp);
  }

  function textTable(group) {
    if (!group) return {};
    if (lang === "en" && group.en) return Object.assign({}, group.de || {}, group.en);
    return group.de || group.en || {};
  }

  function expand(group, text) {
    if (!text || text.indexOf("{") < 0) return text;
    const snippets = (group && group.sn) || {};
    return text.replace(/\{([^{}]+)\}/g, function (_all, name) {
      const dp = snippets[name];
      if (!dp) return "";
      const value = get(dp);
      return value == null ? "" : String(value);
    });
  }

  function localized(group, index) {
    const key = String(index);
    const de = (group.de && group.de[key]) || "";
    const en = (group.en && group.en[key]) || "";
    if (lang === "en") return en || de;
    if (!de) return en;
    if (en && /^P\d{3,5}\b/.test(en) && !/^P\d{3,5}\b/.test(de)) return en;
    return de;
  }

  function textAt(group, index) {
    if (!group || index == null) return "";
    return expand(group, localized(group, index));
  }

  function groupOf(control, layer) {
    if (!control.tg) return null;
    if (control.tg === "@") return layer.tx || null;
    return VISU.groups[control.tg] || null;
  }

  function optionsOf(control, layer) {
    const group = groupOf(control, layer);
    if (!group) return [];
    const keys = Object.keys(textTable(group));
    const offset = control.m ? Number(control.ti || 0) : 0;
    return keys.map(Number).filter(function (n) { return !isNaN(n) && n >= offset; }).sort(function (a, b) { return a - b; })
      .filter(function (n) { return control.max == null || (n - offset) <= Number(control.max); })
      .map(function (n) { return { i: n - offset, t: textAt(group, n) }; })
      .filter(function (opt) { return opt.t !== ""; });
  }

  function actionName(control, text) {
    if (!text || text.indexOf(">0<") < 0) return text;
    const offset = control && control.a && control.a.some(function (act) {
      return /\.iCmd$/.test(act[0]) && Number(act[1]) === 1;
    });
    const word = lang === "en" ? "Set Offset" : "Nullpunkt";
    if (offset && text === ">0<") return word;
    if (/WC\d+:\s*>0</.test(text)) return text.replace(">0<", word);
    return text;
  }

  function labelOf(control, layer) {
    if (control.td) {
      const direct = get(control.td);
      if (direct != null && direct !== "") return String(direct);
    }
    if (control.tid) {
      const value = textAt(groupOf(control, layer), Number(get(control.tid) || 0) + Number(control.ti || 0));
      if (value) return actionName(control, value);
    }
    if (control.tg && !control.m && control.ti != null) {
      return actionName(control, textAt(groupOf(control, layer), control.ti || 0));
    }
    if (control.dp && control.k !== "drop" && control.k !== "list" && control.k !== "bitmap" && control.k !== "button" && control.k !== "hot") {
      const value = get(control.dp);
      if (value != null && value !== "") return String(value);
    }
    if (control.sim != null && control.k !== "drop" && control.k !== "list" && control.k !== "button" && control.k !== "bitmap") {
      return String(control.sim);
    }
    return "";
  }

  function bitmapName(control) {
    if (control.bm) return control.bm;
    if (!control.bmg || !VISU.bmgrp || !VISU.bmgrp[control.bmg]) return "";
    const index = control.dp ? (get(control.dp) ?? control.bmi ?? 0) : (control.bmi ?? 0);
    return VISU.bmgrp[control.bmg][String(index)] || "";
  }

  function align(value) {
    return value === "c" ? "center" : value === "r" ? "flex-end" : "flex-start";
  }
  function valign(value) {
    return value === "m" ? "center" : value === "b" ? "flex-end" : "flex-start";
  }

  function arrayKey(arr, index) {
    const sample = known.find(function (key) { return key.indexOf(arr + "[") >= 0; });
    if (!sample) return "Visu.VisuCtrl." + arr + "[" + index + "]";
    const at = sample.lastIndexOf(arr + "[");
    return sample.slice(0, at) + arr + "[" + index + "]";
  }

  function applyShow(arr, indices) {
    for (let i = 0; i < 40; i++) store[arrayKey(arr, i)] = indices.indexOf(i) >= 0 ? 0 : 1;
  }

  function findCmd(dp, value) {
    const key = String(value);
    const exprs = Object.keys(VISU.cmds || {});
    for (let i = 0; i < exprs.length; i++) {
      const expr = exprs[i];
      if (dp === expr || dp.endsWith("." + expr)) {
        return (VISU.cmds[expr] || {})[key] || null;
      }
    }
    return null;
  }

  function closePop() {
    const pop = document.getElementById("pop");
    const pad = document.getElementById("pad");
    if (pop) pop.remove();
    if (pad) pad.remove();
  }

  function currentPage() {
    return byIndex.get(pageIndex) || null;
  }

  function gotoIndex(index, back) {
    index = Number(index);
    if (!byIndex.has(index)) {
      crumb.textContent = "Seite " + index + " ist in dieser Visu nicht vorhanden";
      return;
    }
    if (index === 45 && pageIndex !== 45 && !keep45) {
      applyShow("strPage45.uiPxxxRT", []);
      applyShow("strPage45.uiButtonLayer", []);
      store["strPage45.uiLayerHandling"] = 1;
    }
    const entered = index !== pageIndex;
    if (entered) {
      if (!back) history.push(pageIndex);
      pageIndex = index;
      initWc();
      if (pageIndex === 7010) enterPage7010();
      enterIoPages(true);
    }
    if (location.hash !== "#" + pageIndex) location.hash = String(pageIndex);
    closePop();
    render();
    save();
  }

  function gotoName(name) {
    const page = VISU.pages.find(function (item) { return item.name === name; });
    if (page) gotoIndex(page.index);
  }

  function goBack() {
    const prev = history.pop();
    if (prev == null) return;
    pageIndex = prev;
    location.hash = String(pageIndex);
    closePop();
    render();
    save();
  }

  function parSwitch(taste, basis) {
    const rows = VISU.par || [];
    let ix = 0;
    for (; ix < rows.length && rows[ix][0] < basis; ix++) {}
    if (taste === 2) {
      ix++;
      for (; ix < rows.length && rows[ix][1] !== "T"; ix++) {
        if (rows[ix][1] === "E") { gotoIndex(9900); return; }
      }
      if (rows[ix]) gotoIndex(rows[ix][0]);
      return;
    }
    if (taste === 1) {
      ix++;
      while (rows[ix] && (skipPar(rows[ix][0]) || !byIndex.has(rows[ix][0]))) ix++;
      if (rows[ix]) gotoIndex(rows[ix][0]);
      return;
    }
    if (taste === -1) {
      ix = Math.max(0, ix - 1);
      while (ix > 0 && (skipPar(rows[ix][0]) || !byIndex.has(rows[ix][0]))) ix--;
      if (rows[ix] && byIndex.has(rows[ix][0])) gotoIndex(rows[ix][0]);
      return;
    }
    if (taste === -2) {
      ix = Math.max(0, ix - 1);
      for (; ix > 0 && rows[ix][1] !== "T"; ix--) {
        if (rows[ix][1] === "S") break;
      }
      if (rows[ix]) gotoIndex(rows[ix][0]);
    }
  }

  function normSwitch(taste, basis) {
    const rows = (VISU.norm || []).map(function (row, index) {
      return [row[0], row[1], index < 3 || skipNorm(row[0]) ? "J" : "N"];
    });
    let ix = 0;
    for (; ix < rows.length && rows[ix][0] < basis; ix++) {
      if (rows[ix][1] === "E") break;
    }
    if (taste === 1) {
      if (basis === 10) { gotoIndex(grafikPage()); return; }
      if ((rows[ix + 1] && rows[ix + 1][1] === "E") || basis === 41) ix = 0;
      else ix++;
      while (rows[ix] && rows[ix][2] === "J") ix++;
      if (rows[ix]) gotoIndex(rows[ix][0]);
      return;
    }
    if (taste === -1) {
      if (basis === grafikPage()) {
        let end = 0;
        for (; rows[end] && rows[end][1] !== "E"; end++) {}
        if (rows[end] && rows[end][2] !== "J") { gotoIndex(rows[end][0]); return; }
      }
      ix = Math.max(0, ix - 1);
      while (ix > 0 && rows[ix][2] === "J") ix--;
      if (rows[ix]) gotoIndex(rows[ix][0] === 0 && basis !== 0 ? 10 : rows[ix][0]);
    }
  }

  function page45(cmd, depth) {
    cmd = Number(cmd);
    if ((depth || 0) > 8) return;
    const chain = { 1004: 2, 2001: 1, 2004: 3, 3001: 2, 3004: 4, 4001: 3, 4004: 5, 5001: 4, 5004: 6, 6001: 5, 6004: 7, 7001: 6 };
    const direct = { 1002: 1000, 1003: 1000, 2002: 2000, 2003: 2000, 3002: 3000, 3003: 3000, 4002: 4000, 4003: 4000, 5002: 5000, 5003: 5000, 6002: 6000, 6003: 6000, 7002: 7000, 7003: 7000 };
    if (chain[cmd]) { page45(chain[cmd], (depth || 0) + 1); return; }
    if (direct[cmd]) { gotoIndex(direct[cmd]); return; }
    if (cmd >= 1 && cmd <= 7) {
      showGroup(cmd - 1);
      if (pageIndex !== 45) {
        keep45 = true;
        gotoIndex(45);
        keep45 = false;
      } else { render(); save(); }
      return;
    }
    if (cmd === 100) {
      applyShow("strPage45.uiPxxxRT", []);
      render();
      save();
    }
  }

  function page45Button(cmd) {
    cmd = Number(cmd);
    if (cmd === 100) { store["strPage45.uiLayerHandling"] = 0; render(); save(); return; }
    if (cmd === 500 || cmd === 501) {
      store["strPage45.uiLayerHandling"] = 1;
      store["strPage45.iCmdButton"] = 0;
      gotoIndex(5);
    }
  }

  function onBild(value) {
    const taste = Number(value);
    if (taste === 3) { goBack(); return; }
    if (pageIndex >= 1000) {
      const group = { 11: 0, 12: 1, 13: 2, 14: 3, 15: 4, 16: 5, 17: 6 }[taste];
      if (group != null) {
        showGroup(group);
        keep45 = true;
        gotoIndex(45);
        keep45 = false;
        return;
      }
      parSwitch(taste, pageIndex);
      return;
    }
    if (pageIndex <= 43) {
      if (taste === 4) { gotoIndex(grafikPage()); return; }
      normSwitch(taste, pageIndex);
    }
  }

  function initWc() {
    const page = currentPage();
    if (!page) return;
    const seen = {};
    (page.layers || []).forEach(function (layer) {
      const match = /(.*strPage50(?:00|10|20|30|40|50)\.LayerHandling)\[\d+\]/.exec(layer.st || "");
      if (!match || seen[match[1]]) return;
      seen[match[1]] = true;
      applyShow(match[1], [0]);
    });
  }

  function wcCmd(dp, value) {
    const match = /(.*strPage50(?:00|10|20|30|40|50))\.iCmd$/.exec(dp);
    if (!match) return false;
    const cmd = Number(value);
    const show = cmd === 1 ? [1] : cmd === 2 ? [2] : (cmd === 10 || cmd === 11) ? [0] : null;
    if (!show) return false;
    applyShow(match[1] + ".LayerHandling", show);
    render();
    save();
    return true;
  }

  function panelCmd(value) {
    const cmd = Number(value);
    const offset = { 5004: 0, 5014: 1, 5024: 2, 5034: 3, 5044: 4, 5054: 5 };
    const span = { 5006: 0, 5016: 1, 5026: 2, 5036: 3, 5046: 4, 5056: 5 };
    const analog = { 5204: 0, 5214: 1, 5224: 2, 5234: 3 };
    if (offset[cmd] != null) {
      const index = offset[cmd];
      store["xP" + (5004 + index * 10) + ".diValue"] = n("fromX20.pzd.lWkuV[" + index + "]");
    } else if (span[cmd] != null) {
      const index = span[cmd];
      const measured = n("fromX20.pzd.lWkuV[" + index + "]");
      const zero = p(5004 + index * 10);
      const ref = n("Visu.VisuCtrl.iSpanPro");
      if (measured >= zero && ref > 0) store["xP" + (5006 + index * 10) + ".diValue"] = ((measured - zero) * 10000) / ref;
    } else if (analog[cmd] != null) {
      const index = analog[cmd];
      store["xP" + (5204 + index * 10) + ".diValue"] = n("fromX20.pzd.iStatAnInAbs[" + index + "]");
    }
    render();
    save();
  }

  function onCmd(dp, value) {
    if (dp === "strPage45.iCMD" || dp.endsWith(".strPage45.iCMD")) {
      store[dp] = 0;
      page45(value);
      return;
    }
    if (wcCmd(dp, value)) return;
    if (dp.endsWith("strPage40.strNav.uiCMD")) { store[dp] = 0; page40Nav(value); return; }
    if (dp.endsWith("strPage40.strIO_Check.iCmdIO")) { store[dp] = 0; page40Force(value); return; }
    if (dp.endsWith("strPage50.iCmdButton")) { store[dp] = 0; page50(value); return; }
    if (dp.endsWith("strPage52.sAiNr")) { page52(value); return; }
    if (dp.endsWith("strPage56.sAONr")) { store[dp] = 0; page56(value); return; }
    if (dp.endsWith("strPage61.uiCmdButton")) { store[dp] = 0; page61(value); return; }
    if (dp.endsWith("strPage64.iCmdVisu")) { store[dp] = 0; page64(value); return; }
    if (dp.endsWith("strPage70.uiCmdButton")) { store[dp] = 0; page70(value); return; }
    if (dp.endsWith("strPage76.icmdVisu")) { store[dp] = 0; page76(value); return; }
    if (dp.endsWith("strPage78.icmdVisu")) { store[dp] = 0; page78(value); return; }
    if (dp.endsWith("strPage08.iCMD")) { store[dp] = 0; page8(value); return; }
    if (dp.endsWith("strPage29.uiCmdButton")) { store[dp] = 0; page29(value); return; }
    const spec = findCmd(dp, value);
    store[dp] = 0;
    if (!spec) { render(); return; }
    (spec.layers || []).forEach(function (layer) { applyShow(layer.arr, layer.show || []); });
    if (spec.page != null) gotoIndex(spec.page);
    else { render(); save(); }
  }

  function runActs(acts) {
    if (!acts) return;
    let painted = false;
    acts.forEach(function (act) {
      const dp = act[0];
      const value = act[1];
      if (dp === "@page") { gotoName(value); painted = true; return; }
      store[dp] = value;
      if (dp === "setPage" || dp.endsWith(".setPage")) { gotoIndex(value); painted = true; }
      else if (/(?:^|\.)iNrDwc$/.test(dp) && pageIndex === 10) { openScale(); painted = true; }
      else if (dp.endsWith("sBildLaufCmd")) { onBild(value); painted = true; }
      else if (dp.endsWith("strPage45.iCmdButton")) { page45Button(value); painted = true; }
      else if (/(?:^|\.)(?:iCmd|iCmdIO|iCmdButton|iCmdVisu|iCMD|uiCMD|uiCmdButton|icmdVisu|sAiNr|sAONr)$/.test(dp)) { onCmd(dp, value); painted = true; }
      else if (/(?:^|\.)lCmdPanel$/.test(dp)) { panelCmd(value); painted = true; }
      else if (dp.endsWith("bCMDLangChange")) {
        store[dp] = 0;
        if (pageIndex !== 7 && pageIndex !== 15 && parameterLang()) {
          store["Visu.VisuCtrl.uiLangStep"] = n("Visu.VisuCtrl.uiLangStep") === 1 ? 0 : 1;
        }
        render();
        save();
        painted = true;
      }
    });
    if (!painted) { render(); save(); }
  }

  function openDrop(control, layer, anchor) {
    closePop();
    const opts = optionsOf(control, layer);
    const current = Number(get(control.dp) ?? control.sim ?? (opts[0] ? opts[0].i : 0));
    const pop = document.createElement("div");
    pop.id = "pop";
    opts.forEach(function (opt) {
      const row = document.createElement("div");
      row.className = "opt" + (opt.i === current ? " on" : "");
      row.textContent = opt.t;
      row.addEventListener("click", function (event) {
        event.stopPropagation();
        if (control.dp) store[control.dp] = opt.i;
        closePop();
        if (control.a) runActs(control.a);
        else { render(); save(); }
      });
      pop.appendChild(row);
    });
    if (!opts.length) {
      const row = document.createElement("div");
      row.className = "opt";
      row.textContent = "(keine Texte)";
      pop.appendChild(row);
    }
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    pop.style.left = rect.left + "px";
    pop.style.minWidth = Math.max(rect.width, 140) + "px";
    const below = rect.bottom + 4;
    if (below + 220 > window.innerHeight) pop.style.top = Math.max(8, rect.top - Math.min(240, pop.offsetHeight + 4)) + "px";
    else pop.style.top = below + "px";
  }

  function openPad(control, layer) {
    closePop();
    const numeric = control.k === "num" || (control.pad && /num/i.test(control.pad) && control.k !== "str" && control.k !== "edit");
    const pad = document.createElement("div");
    pad.id = "pad";
    const input = document.createElement("input");
    input.value = labelOf(control, layer);
    pad.appendChild(input);
    function commit() {
      const raw = input.value;
      const value = numeric && raw !== "" && !isNaN(Number(raw)) ? Number(raw) : raw;
      if (control.dp) store[control.dp] = value;
      else if (control.td) store[control.td] = value;
      closePop();
      if (control.a) runActs(control.a);
      else { render(); save(); }
    }
    if (numeric) {
      const keys = document.createElement("div");
      keys.className = "keys";
      ["7", "8", "9", "4", "5", "6", "1", "2", "3", "-", "0", "."].forEach(function (key) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = key;
        button.addEventListener("click", function () {
          if (key === "-") input.value = input.value.startsWith("-") ? input.value.slice(1) : "-" + input.value;
          else input.value += key;
          input.focus();
        });
        keys.appendChild(button);
      });
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "wide";
      ok.textContent = "OK";
      ok.addEventListener("click", commit);
      keys.appendChild(ok);
      pad.appendChild(keys);
    } else {
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "wide";
      ok.textContent = "Übernehmen";
      ok.addEventListener("click", commit);
      pad.appendChild(ok);
    }
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); commit(); }
      if (event.key === "Escape") closePop();
    });
    document.body.appendChild(pad);
    input.focus();
    input.select();
  }

  function addText(el, text) {
    const span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);
    return span;
  }

  function paintImage(el, name) {
    const src = name && VISU.bm && VISU.bm[name];
    if (!src) return false;
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);
    return true;
  }

  function applyFace(el, control) {
    const border = control.bd && VISU.borders && VISU.borders[control.bd];
    const src = border && VISU.bm && VISU.bm[border.bm];
    if (!src) return false;
    const sl = border.sl || 0;
    const sr = border.sr || 0;
    const st = border.st || 0;
    const sb = border.sb || 0;
    el.classList.add("faced");
    el.style.borderStyle = "solid";
    el.style.borderColor = "transparent";
    el.style.borderWidth = st + "px " + sr + "px " + sb + "px " + sl + "px";
    el.style.borderImageSource = "url('" + src + "')";
    el.style.borderImageSlice = st + " " + sr + " " + sb + " " + sl + " fill";
    el.style.borderImageWidth = "1";
    el.style.borderImageRepeat = "stretch";
    el.style.boxShadow = "none";
    el.style.background = "transparent";
    const ph = border.ph || 0;
    const pv = border.pv || 0;
    if (ph || pv) el.style.padding = pv + "px " + ph + "px";
    return true;
  }

  function paintGlyph(el, name, control) {
    const src = name && VISU.bm && VISU.bm[name];
    if (!src) return false;
    const img = document.createElement("img");
    img.className = "glyph";
    img.src = src;
    img.alt = "";
    img.draggable = false;
    const h = control.bah || "l";
    const v = control.bav || "m";
    img.style.left = h === "r" ? "auto" : h === "c" ? "50%" : "0";
    img.style.right = h === "r" ? "0" : "auto";
    img.style.top = v === "b" ? "auto" : v === "m" ? "50%" : "0";
    img.style.bottom = v === "b" ? "0" : "auto";
    const tx = h === "c" ? "-50%" : "0";
    const ty = v === "m" ? "-50%" : "0";
    if (tx !== "0" || ty !== "0") img.style.transform = "translate(" + tx + ", " + ty + ")";
    el.appendChild(img);
    return true;
  }

  function formatNow(pattern) {
    const now = new Date();
    const pad = function (value) { return String(value).padStart(2, "0"); };
    return String(pattern)
      .replace(/%Y/g, String(now.getFullYear()))
      .replace(/%y/g, pad(now.getFullYear() % 100))
      .replace(/%m/g, pad(now.getMonth() + 1))
      .replace(/%d/g, pad(now.getDate()))
      .replace(/%H/g, pad(now.getHours()))
      .replace(/%h/g, pad(now.getHours() % 12 || 12))
      .replace(/%M/g, pad(now.getMinutes()))
      .replace(/%S/g, pad(now.getSeconds()));
  }

  function renderControl(control, layer, z) {
    if (control.st && !shown(control.st)) return;
    const el = document.createElement("div");
    el.className = "c k-" + control.k + (control.in ? " in" : "");
    el.style.zIndex = String(z);
    el.style.left = (control.x || 0) + "px";
    el.style.top = (control.y || 0) + "px";
    if (control.fs) el.style.fontSize = control.fs + "px";
    el.style.lineHeight = "1";
    el.style.fontFamily = (control.ff || "Arial") + ", sans-serif";
    el.style.fontWeight = control.fb ? "700" : "400";
    if (control.ml) el.style.whiteSpace = "normal";
    if (control.fg) el.style.color = control.fg;
    el.style.justifyContent = align(control.al);
    el.style.alignItems = valign(control.av);
    if (control.k === "line") {
      const x1 = control.x || 0, y1 = control.y || 0, x2 = control.x2 || 0, y2 = control.y2 || 0;
      el.style.left = Math.min(x1, x2) + "px";
      el.style.top = Math.min(y1, y2) + "px";
      el.style.width = Math.max(2, Math.abs(x2 - x1) || 2) + "px";
      el.style.height = Math.max(2, Math.abs(y2 - y1) || 2) + "px";
      if (control.fg) el.style.background = control.fg;
      stage.appendChild(el);
      return;
    }
    el.style.width = (control.w || 0) + "px";
    el.style.height = (control.h || 0) + "px";
    if (control.bg) el.style.background = control.bg;
    const faced = applyFace(el, control);
    if (!faced && (control.sh || control.sv)) el.style.padding = (control.sv || 0) + "px " + (control.sh || 0) + "px";
    const text = labelOf(control, layer);
    const bitmap = bitmapName(control);
    if (control.k === "button" || control.k === "hot") {
      if (bitmap) paintGlyph(el, bitmap, control);
      if (text) addText(el, text);
    } else if (control.k === "drop") {
      const opts = optionsOf(control, layer);
      const current = Number(get(control.dp) ?? control.sim ?? (opts[0] ? opts[0].i : 0));
      const hit = opts.find(function (opt) { return opt.i === current; });
      addText(el, hit ? hit.t : text);
    } else if (control.k === "list") {
      el.style.flexDirection = "column";
      el.style.alignItems = "stretch";
      el.style.overflow = "auto";
      el.style.whiteSpace = "normal";
      const opts = optionsOf(control, layer);
      const current = Number(get(control.dp) ?? control.sim ?? 0);
      opts.forEach(function (opt) {
        const row = document.createElement("div");
        row.className = "opt" + (opt.i === current ? " on" : "");
        row.textContent = opt.t;
        row.addEventListener("click", function (event) {
          event.stopPropagation();
          if (control.dp) store[control.dp] = opt.i;
          if (control.a) runActs(control.a);
          else { render(); save(); }
        });
        el.appendChild(row);
      });
    } else if (control.k === "bar" || control.k === "slider" || control.k === "gauge" || control.k === "scale") {
      const value = Number(get(control.dp) ?? control.sim ?? 0);
      const min = Number(control.vmin || 0);
      const max = Number(control.vmax || 100);
      const pct = Math.max(0, Math.min(1, (value - min) / ((max - min) || 1)));
      const bar = document.createElement("div");
      bar.className = "bar";
      if (control.bc) bar.style.background = control.bc;
      const vertical = control.ori === "Up" || control.ori === "Down";
      if (vertical) {
        bar.style.left = "0";
        bar.style.width = "100%";
        bar.style.height = (pct * 100) + "%";
        if (control.ori === "Up") { bar.style.bottom = "0"; }
        else bar.style.top = "0";
      } else if (control.ori === "Left") {
        bar.style.top = "0";
        bar.style.bottom = "0";
        bar.style.right = "0";
        bar.style.width = (pct * 100) + "%";
      } else {
        bar.style.top = "0";
        bar.style.bottom = "0";
        bar.style.left = "0";
        bar.style.width = (pct * 100) + "%";
      }
      el.appendChild(bar);
      if (text) addText(el, text);
    } else if (control.k === "bitmap") {
      paintImage(el, bitmap);
    } else if (control.k === "trend" || control.k === "alarm") {
      if (text) addText(el, text);
    } else if (control.k === "pass") {
      addText(el, text ? "•".repeat(Math.min(12, String(text).length)) : "");
    } else if (control.k === "time") {
      const pattern = textAt(groupOf(control, layer), control.ti || 0) || "%H:%M:%S";
      el.dataset.time = pattern;
      addText(el, formatNow(pattern));
    } else if (text) {
      addText(el, text);
    }
    const clickable = control.k === "button" || control.k === "hot" || control.k === "drop" || control.in;
    el.style.pointerEvents = clickable ? "auto" : "none";
    if (control.k === "list") el.style.pointerEvents = "auto";
    if (clickable || control.k === "list") {
      el.setAttribute("role", "button");
      if (text) el.setAttribute("aria-label", text);
    }
    if (clickable) {
      el.addEventListener("click", function (event) {
        event.stopPropagation();
        if (control.k === "drop") { openDrop(control, layer, el); return; }
        if (control.in && control.k !== "drop" && control.k !== "list") { openPad(control, layer); return; }
        runActs(control.a);
      });
    }
    if (control.dp) el.title = control.n + " · " + control.dp;
    stage.appendChild(el);
  }

  function render() {
    const page = currentPage();
    stage.innerHTML = "";
    if (!page) {
      crumb.textContent = "Seite nicht gefunden";
      return;
    }
    applyGrafik();
    stage.style.background = page.bg || "#D9D9D9";
    frame.style.background = page.bg || "#D9D9D9";
    const layers = (page.layers || []).slice().sort(function (a, b) {
      return (a.z - b.z) || (a.seq - b.seq);
    });
    let z = 1;
    layers.forEach(function (layer) {
      if (layer.off) return;
      if (layer.st && !shown(layer.st)) return;
      (layer.controls || []).forEach(function (control) {
        renderControl(control, layer, z);
        z += 1;
      });
    });
    crumb.textContent = page.index + " · " + page.name;
    parSelect();
    startBild = grafikPage();
    const waage = document.getElementById("waage");
    const hardware = document.getElementById("hw");
    if (waage && document.activeElement !== waage) {
      const art = p(1020);
      waage.value = String([0, 1, 2, 3, 4].indexOf(art) >= 0 ? art : 0);
    }
    if (hardware && document.activeElement !== hardware) hardware.value = String(hw());
    markList();
    fit();
  }

  function markList() {
    list.querySelectorAll("button").forEach(function (button) {
      const index = Number(button.dataset.index);
      button.classList.toggle("on", index === pageIndex);
      button.classList.toggle("skip", arrowSkips(index));
    });
  }

  function renderList() {
    const query = document.getElementById("find").value.trim().toLowerCase();
    list.innerHTML = "";
    let section = "";
    VISU.pages.forEach(function (page) {
      const blob = (page.index + " " + page.name).toLowerCase();
      if (query && blob.indexOf(query) < 0) return;
      const next = page.index >= 1000 ? "Parameter" : "Bedienung";
      if (next !== section) {
        section = next;
        const title = document.createElement("h2");
        title.textContent = section;
        list.appendChild(title);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.index = String(page.index);
      button.textContent = page.index + "  " + page.name;
      button.addEventListener("click", function () { gotoIndex(page.index); });
      list.appendChild(button);
    });
    markList();
  }

  const bild = /(?:^|[?&])bild=1(?:&|$)/.test(location.search);
  if (bild) document.body.classList.add("bild");

  let fields = null;

  function fieldIndex() {
    if (fields) return fields;
    fields = {};
    VISU.pages.forEach(function (page) {
      (page.layers || []).forEach(function (layer) {
        (layer.controls || []).forEach(function (control) {
          if (!control.dp) return;
          if (control.k === "text" || control.k === "bitmap" || control.k === "button" || control.k === "hot" || control.k === "shape") return;
          const fromDp = /(?:^|[.\]])x?([PR])(\d{3,5})(?!\d)/.exec(control.dp);
          if (!fromDp) return;
          const key = fromDp[1].toUpperCase() + fromDp[2];
          const named = /^([PR])(\d+)V$/i.exec(control.n || "");
          const agrees = named && named[1].toUpperCase() + named[2] === key;
          if (!fields[key] || agrees) fields[key] = control.dp;
        });
      });
    });
    return fields;
  }

  function parseCsvValue(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return null;
    const compact = text.replace(/\s+/g, "").replace(",", ".");
    if (/^[+-]?\d+(?:\.\d+)?$/.test(compact)) return Number(compact);
    return text;
  }

  function normalizeCsv(text) {
    let value = String(text || "");
    if (value.charCodeAt(0) === 0xFEFF) value = value.slice(1);
    if (value.indexOf("\u0000") >= 0) value = value.replace(/\u0000/g, "");
    return value;
  }

  function collectCsv(text, target) {
    const map = fieldIndex();
    normalizeCsv(text).split(/\r?\n/).forEach(function (line) {
      const name = String(line.split(";")[0] || "").trim();
      const hit = /^([PR])(\d+)\b/i.exec(name);
      if (!hit) return;
      if (/^R9700\b/i.test(name)) {
        const slot = parseCsvValue(line.split(";")[1]);
        if (slot == null) return;
        const code = busCode(slot);
        target["xPconf.P9700_txtBusType"] = String(slot).trim();
        if (code) {
          target["fromX20.pzd.iBusTyp"] = code;
          target["strR.R9700_sBusVersion[0]"] = code;
        }
        return;
      }
      const hwKey = hit[1].toUpperCase() + hit[2];
      if (HW_SLOTS[hwKey]) {
        const slotText = parseCsvValue(line.split(";")[1]);
        if (slotText == null) return;
        target[HW_SLOTS[hwKey][0]] = String(slotText).trim();
        writeSlots(HW_SLOTS[hwKey][1], slotText, target);
        return;
      }
      const dp = map[hit[1].toUpperCase() + hit[2]];
      if (!dp) return;
      const value = parseCsvValue(line.split(";")[1]);
      if (value == null) return;
      target[dp] = dp === "xP1070.diValue" ? languageCode(value) : value;
    });
  }

  function applyParameterCsv(text) {
    collectCsv(text, store);
  }

  function followScale() {
    const next = grafikPage();
    if (pageIndex >= 20 && pageIndex <= 24 && pageIndex !== next && byIndex.has(next)) pageIndex = next;
  }

  function fit() {
    const main = document.querySelector("main");
    const mainCs = getComputedStyle(main);
    const frameCs = getComputedStyle(frame);
    const padX = parseFloat(mainCs.paddingLeft) + parseFloat(mainCs.paddingRight);
    const padY = parseFloat(mainCs.paddingTop) + parseFloat(mainCs.paddingBottom);
    const borderX = parseFloat(frameCs.borderLeftWidth) + parseFloat(frameCs.borderRightWidth);
    const borderY = parseFloat(frameCs.borderTopWidth) + parseFloat(frameCs.borderBottomWidth);
    let extraY = 0;
    if (getComputedStyle(crumb).display !== "none") {
      extraY += crumb.offsetHeight + (parseFloat(mainCs.rowGap || mainCs.gap) || 0);
    }
    const scale = Math.max(0.45, Math.min(
      (main.clientWidth - padX - borderX) / 640,
      (main.clientHeight - padY - borderY - extraY) / 480
    ));
    stage.style.transform = "scale(" + scale + ")";
    frame.style.width = (640 * scale) + "px";
    frame.style.height = (480 * scale) + "px";
  }

  document.getElementById("lang").value = lang;
  document.getElementById("lang").addEventListener("change", function (event) {
    lang = event.target.value;
    store["Visu.VisuCtrl.uiLangStep"] = lang === "en" && parameterLang() ? 1 : 0;
    save();
    render();
  });
  document.getElementById("back").addEventListener("click", goBack);
  document.getElementById("overview").addEventListener("click", function () { gotoIndex(10); });
  document.getElementById("graphic").addEventListener("click", function () { gotoIndex(grafikPage()); });
  document.getElementById("waage").addEventListener("change", function (event) {
    store["xP1020.diValue"] = Number(event.target.value);
    const next = grafikPage();
    if (pageIndex >= 20 && pageIndex <= 24 && pageIndex !== next) gotoIndex(next);
    else { save(); renderList(); render(); }
  });
  document.getElementById("hw").addEventListener("change", function (event) {
    store["iDWC_HW"] = Number(event.target.value);
    save();
    renderList();
    render();
  });
  document.getElementById("reset").addEventListener("click", function () {
    freshStore();
    ensurePlant();
    slots = [null, null, null];
    paintRows();
    save();
    renderList();
    render();
  });
  document.getElementById("find").addEventListener("input", renderList);
  document.addEventListener("click", function (event) {
    if (event.target.closest && event.target.closest("#pop, #pad")) return;
    closePop();
  });
  document.addEventListener("keydown", function (event) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (document.getElementById("pad")) return;
    if (event.key === "ArrowDown") { event.preventDefault(); onBild(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); onBild(-1); }
    else if (event.key === "PageDown") { event.preventDefault(); onBild(pageIndex >= 1000 ? 2 : 1); }
    else if (event.key === "PageUp") { event.preventDefault(); onBild(pageIndex >= 1000 ? -2 : -1); }
    else if (event.key === "Backspace") { event.preventDefault(); goBack(); }
    else if (event.key === "Escape") closePop();
  });
  window.addEventListener("resize", fit);
  window.addEventListener("hashchange", function () {
    const raw = location.hash.slice(1);
    if (raw === "") return;
    const index = Number(raw);
    if (!isNaN(index) && index !== pageIndex && byIndex.has(index)) {
      history.push(pageIndex);
      pageIndex = index;
      initWc();
      if (pageIndex === 7010) enterPage7010();
      enterIoPages(true);
      render();
    }
  });

  function deliverCsv(data) {
    if (data.slot != null && data.slot !== "") {
      loadSlot(Number(data.slot), data.text || "");
      return;
    }
    if (data.reset) {
      freshStore();
      ensurePlant();
      slots = [null, null, null];
    }
    if (Array.isArray(data.texts)) {
      data.texts.forEach(function (text, index) {
        applyParameterCsv(text);
        if (index < 3 && text) {
          const values = {};
          collectCsv(text, values);
          slots[index] = values;
        }
      });
    }
    if (data.text) applyParameterCsv(data.text);
    followScale();
    paintRows();
    save();
    render();
  }

  window.OPCG = {
    applyParameterCsv: function (text) { deliverCsv({ text: text }); },
    resetParameters: function () { deliverCsv({ reset: true }); }
  };

  window.addEventListener("message", function (event) {
    const data = event.data;
    if (!data || data.type !== "opcg-csv") return;
    if (event.origin && event.origin !== "null" && event.origin !== location.origin) return;
    deliverCsv(data);
  });

  setInterval(function () {
    stage.querySelectorAll("[data-time]").forEach(function (el) {
      const span = el.querySelector("span");
      if (span) span.textContent = formatNow(el.dataset.time);
    });
  }, 1000);

  ensurePlant();
  paintRows();
  renderList();
  const rawHash = location.hash.slice(1);
  if (rawHash !== "" && !isNaN(Number(rawHash)) && byIndex.has(Number(rawHash))) pageIndex = Number(rawHash);
  initWc();
  if (pageIndex === 7010) enterPage7010();
  if (pageIndex === 40) initPage40();
  render();
})();
