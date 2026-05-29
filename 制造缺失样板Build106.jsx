/**
 * ME 样板库助手 v6.0 (1.21.1+ 路径自适应版)
 * 增加：非原版物品自动监听并添加到当前库。
 * 增加：支持通过中文名称匹配物品制作样板。
 * 增加：自动跳过并标记原版物品 (minecraft:*)。
 * 增加：43槽产物制作后丢弃。
 * 优化：增加操作延迟，提升服务器兼容性。
 * 增加：未匹配时自动搜索附近海晶石砖并打开。
 * 修复：优先从Lore中提取Slimefun物品ID。
 * 修复：统一ID大小写，避免重复保存。
 * 增加：ALT+中键记录光标所在槽物品到当前库。
 * 增加：CTRL+中键删除当前库中对应物品。
 */

// ======================== 路径自动解析 ========================
const MASTER_FILE_NAME = "existing_patterns.json";
const SAVE_FILE_NAME = "now_existing_patterns.json";
const RELATIVE_DIR = "./config/jsMacros/Macros/";

const File = Java.type("java.io.File");
const MASTER_PATH = new File(RELATIVE_DIR + MASTER_FILE_NAME).getAbsolutePath();
const SAVE_PATH = new File(RELATIVE_DIR + SAVE_FILE_NAME).getAbsolutePath();
const NORMALIZED_PATH = new File(RELATIVE_DIR + "normalized_ids.json").getAbsolutePath();

const SCRIPT_ID = "ME_Scanner_Final_V59";
const TARGET_TITLE = "ME合成计划终端";
const INTERFACE_TITLE = "ME样板接口";
const WORKBENCH_TITLE = "样板工作台";

// 延迟配置（单位：tick，1 tick = 0.05秒）
const DELAY = {
    CLICK: 10,
    SEARCH: 30,
    SWITCH: 12,
    DROP: 10,
    SAVE: 5
};

// ======================== 全局变量 ========================
let isCrafting = false;
let currentTickListener = null;
let pendingCloseScreen = false;

// ======================== 非原版物品监听 ========================
class TextHelper {
    static getStr(text) {
        return text.getString();
    }
}

class ItemMonitor {
    static existingPatternNames = null; // 延迟加载
    
    static loadPatternNames() {
        if (ItemMonitor.existingPatternNames !== null) return;
        ItemMonitor.existingPatternNames = new Set();
        
        // 从 normalized_ids.json 加载原版物品名称
        try {
            if (FS.exists(NORMALIZED_PATH)) {
                let content = FS.open(NORMALIZED_PATH).read();
                let data = JSON.parse(content);
                // 提取所有中文名作为原版物品名称
                ItemMonitor.existingPatternNames = new Set(Object.keys(data));
                Chat.log("§a[监听] 已加载 " + ItemMonitor.existingPatternNames.size + " 个原版物品名");
            } else {
                Chat.log("§c[监听] normalized_ids.json 不存在，无法判断原版物品");
            }
        } catch(e) {
            Chat.log("§c[监听] 加载 normalized_ids.json 失败: " + e);
        }
    }
    
    static stripColor(str) {
        return str.replace(/§./g, "");
    }
    
    static async checkAndRecord(message) {
        ItemMonitor.loadPatternNames();
        let cleanMsg = ItemMonitor.stripColor(message);
        let regex = /- (.+?) x \d+/g;
        let match;
        let recordedCount = 0;
        
        while ((match = regex.exec(cleanMsg)) !== null) {
            let fullItemName = match[1].trim();
            let itemName = fullItemName.replace(/\s*\(\d+%\)\s*/, "");
            
            // 不在已知列表中 = 非原版
            if (!ItemMonitor.existingPatternNames.has(itemName)) {
                // 检查是否已在 now_existing_patterns.json 中
                let existingMap = {};
                try {
                    if (FS.exists(SAVE_PATH)) {
                        let rawData = JSON.parse(FS.open(SAVE_PATH).read());
                        for (let id in rawData) {
                            existingMap[id.toLowerCase()] = rawData[id];
                        }
                    }
                } catch(e) {}
                
                // 检查是否已存在相同中文名
                let alreadyExists = false;
                for (let id in existingMap) {
                    if (existingMap[id].name === itemName) {
                        alreadyExists = true;
                        break;
                    }
                }
                
                if (!alreadyExists) {
                    let newId = "slimefun:" + itemName;
                    existingMap[newId] = {
                        "name": itemName,
                        "flag": 0
                    };
                    
                    // 保存
                    try {
                        let file = new File(SAVE_PATH);
                        if (!file.getParentFile().exists()) file.getParentFile().mkdirs();
                        let osw = new (Java.type("java.io.OutputStreamWriter"))(new (Java.type("java.io.FileOutputStream"))(file, false), "UTF-8");
                        osw.write(JSON.stringify(existingMap, null, 2));
                        osw.close();
                        Chat.log("§e[监听] 已添加非原版物品: §f" + itemName);
                        recordedCount++;
                    } catch(e) {}
                }
            }
        }
    }
}

// ======================== 启停逻辑 ========================

if (GlobalVars.getBoolean(SCRIPT_ID)) {
    GlobalVars.putBoolean(SCRIPT_ID, false);
    let oldListener = GlobalVars.getObject("ME_Active_Listener");
    if (oldListener) { JsMacros.off(oldListener); GlobalVars.remove("ME_Active_Listener"); }
    let oldTickListener = GlobalVars.getObject("ME_Tick_Listener");
    if (oldTickListener) { JsMacros.off(oldTickListener); GlobalVars.remove("ME_Tick_Listener"); }
    let oldItemListener = GlobalVars.getObject("ME_Item_Listener");
    if (oldItemListener) { JsMacros.off(oldItemListener); GlobalVars.remove("ME_Item_Listener"); }
    if (currentTickListener) {
        try { JsMacros.off(currentTickListener); } catch(e) {}
        currentTickListener = null;
    }
    pendingCloseScreen = false;
    Chat.log("§c[ME助手] 脚本已关闭");
} else {
    GlobalVars.putBoolean(SCRIPT_ID, true);
    Chat.log("§a[ME助手] 极速同步/过滤制作模式已激活！");

    const listener = JsMacros.on("OpenScreen", JavaWrapper.methodToJava((event) => {
        if (!GlobalVars.getBoolean(SCRIPT_ID)) return;
        JavaWrapper.methodToJavaAsync(() => {
            let found = false;
            let retry = 0;
            while (retry < 12 && !found) {
                let inv = Player.openInventory();
                let screen = Hud.getOpenScreen();
                if (inv && screen) {
                    let title = inv.getContainerTitle().replace(/§./g, "");
                    if (title.includes(TARGET_TITLE)) { addScanButtons(screen); found = true; } 
                    else if (title.includes(INTERFACE_TITLE)) { autoFillPatterns(inv); found = true; } 
                    else if (title.includes(WORKBENCH_TITLE)) { addCraftButton(screen); found = true; }
                }
                if (!found) { Client.waitTick(8); retry++; }
            }
        }).run();
    }));
    GlobalVars.putObject("ME_Active_Listener", listener);
    
    // 非原版物品监听器
    let itemListener = JsMacros.on("RecvMessage", JavaWrapper.methodToJava((event) => {
        if (!GlobalVars.getBoolean(SCRIPT_ID)) return;
        ItemMonitor.checkAndRecord(TextHelper.getStr(event.text));
    }));
    GlobalVars.putObject("ME_Item_Listener", itemListener);
    
    // 注册 Tick 监听器
    registerTickListener();
}

// ======================== Tick 监听器管理 ========================

function registerTickListener() {
    // 移除已有的监听器
    if (currentTickListener) {
        try { 
            JsMacros.off(currentTickListener); 
        } catch(e) {}
        currentTickListener = null;
    }
    
    // 注册新的监听器
    currentTickListener = JsMacros.on("Tick", JavaWrapper.methodToJava(() => {
        if (!GlobalVars.getBoolean(SCRIPT_ID)) return;
        
        // 处理待关闭的界面
        if (pendingCloseScreen) {
            let s = Hud.getOpenScreen();
            if (s) {
                s.close();
                pendingCloseScreen = false;
            }
        }
        
        // 制作过程中不处理快捷键，避免冲突
        if (isCrafting) return;
        
        // 检查是否有打开的界面
        let screen = Hud.getOpenScreen();
        if (!screen) return;
        
        let pressKeySet = new Set(KeyBind.getPressedKeys());
        
        // ALT + 鼠标中键 - 记录物品
        if (pressKeySet.has("key.keyboard.left.alt") && pressKeySet.has("key.mouse.middle")) {
            JavaWrapper.methodToJavaAsync(() => {
                if (Hud.getOpenScreen()) {
                    let slot = getUnderMouseSlot();
                    if (slot !== -999 && slot !== -1) {
                        Client.waitTick(2);
                        recordItemToNowExisting(slot);
                    }
                }
            }).run();
        }
        
        // CTRL + 鼠标中键 - 删除物品
        if (pressKeySet.has("key.keyboard.left.control") && pressKeySet.has("key.mouse.middle")) {
            JavaWrapper.methodToJavaAsync(() => {
                if (Hud.getOpenScreen()) {
                    let slot = getUnderMouseSlot();
                    if (slot !== -999 && slot !== -1) {
                        Client.waitTick(2);
                        deleteItemFromNowExisting(slot);
                    }
                }
            }).run();
        }
    }));
    
    GlobalVars.putObject("ME_Tick_Listener", currentTickListener);
}

// ======================== UI 按钮逻辑 ========================

function addScanButtons(screen) {
    let containerX = 0, containerWidth = 0, containerY = 0;
    try {
        containerX = screen.getContainerX ? screen.getContainerX() : 0;
        containerWidth = screen.getContainerWidth ? screen.getContainerWidth() : 0;
        containerY = screen.getContainerY ? screen.getContainerY() : 0;
    } catch (e) {}
    let x = (containerX === 0) ? Math.floor(screen.getWidth() / 2) - 170 : containerX + containerWidth - 85;
    let y = (containerY === 0) ? Math.floor(screen.getHeight() / 2) - 100 : containerY - 32;
    screen.addButton(x, y, 75, 20, "§6§l同步样板", JavaWrapper.methodToJavaAsync(() => { runDeepScan(SAVE_PATH, "当前库"); }));
    screen.addButton(x, y + 22, 75, 20, "§d§l记录总库", JavaWrapper.methodToJavaAsync(() => { runDeepScan(MASTER_PATH, "总库"); }));
}

function addCraftButton(screen) {
    let containerX = 0, containerWidth = 0, containerY = 0;
    try {
        containerX = screen.getContainerX ? screen.getContainerX() : 0;
        containerWidth = screen.getContainerWidth ? screen.getContainerWidth() : 0;
        containerY = screen.getContainerY ? screen.getContainerY() : 0;
    } catch (e) {}
    let x = (containerX === 0) ? Math.floor(screen.getWidth() / 2) + 10 : containerX + containerWidth - 85;
    let y = (containerY === 0) ? Math.floor(screen.getHeight() / 2) - 110 : containerY - 32;
    screen.addButton(x, y, 75, 20, "§b§l一键制作", JavaWrapper.methodToJavaAsync(() => { runAutoCraft(); }));
}

// ======================== 核心逻辑：扫描与合并 ========================

function runDeepScan(targetPath, taskName) {
    let physicalMap = {}; 
    let page = 1;
    let maxPages = 50;
    Chat.log(`§b[系统] §f正在扫描${taskName}...`);
    
    while (GlobalVars.getBoolean(SCRIPT_ID) && page <= maxPages) {
        let inv = Player.openInventory();
        if (!inv || !inv.getContainerTitle().replace(/§./g, "").includes(TARGET_TITLE)) {
            Chat.log(`§c[错误] 未找到ME合成计划终端界面`);
            break;
        }
        
        let slots = inv.getTotalSlots() - 36;
        let pageFound = 0;
        
        for (let i = 0; i < slots; i++) {
            if (i === 44 || i === 53) continue; 
            let item = inv.getSlot(i);
            if (item && !item.isEmpty()) {
                let lore = item.getLore();
                let isCraftable = false;
                if (lore) {
                    for (let line of lore) {
                        let lineStr = line.getString();
                        if (lineStr.includes("可合成") || 
                            lineStr.trim().includes("可合成") ||
                            (lineStr.includes("材料列表") && lineStr.includes("可合成"))) {
                            isCraftable = true;
                            break;
                        }
                    }
                }
                if (isCraftable) {
                    let itemId = getRealId(item).toLowerCase();
                    let itemName = item.getName().getString().replace(/§./g, "");
                    physicalMap[itemId] = itemName;
                    pageFound++;
                    Chat.log(`§7[调试] 第${page}页扫描到: ${itemName} (${itemId})`);
                }
            }
        }
        
        Chat.log(`§e第 ${page} 页扫描完成，本页找到 ${pageFound} 个可合成物品，累计: ${Object.keys(physicalMap).length}`);
        
        let nextBtn = inv.getSlot(53);
        if (nextBtn && !nextBtn.isEmpty() && !nextBtn.getItemId().includes("INACTIVE")) {
            let preSign = generateFingerprint(inv);
            inv.click(53);
            Client.waitTick(DELAY.CLICK);
            
            let moved = false;
            for (let r = 0; r < 10; r++) {
                Client.waitTick(10);
                let postInv = Player.openInventory();
                if (postInv && generateFingerprint(postInv) !== preSign) { 
                    moved = true; 
                    break; 
                }
            }
            if (!moved) {
                Chat.log(`§e[提示] 页面切换超时，停止翻页`);
                break;
            }
            page++;
        } else {
            Chat.log(`§e[提示] 没有更多页面，扫描结束`);
            break;
        }
    }
    
    if (targetPath === SAVE_PATH) {
        let finalMap = {};
        let masterMap = {};
        try { 
            if (FS.exists(MASTER_PATH)) {
                let rawMaster = JSON.parse(FS.open(MASTER_PATH).read());
                for (let id in rawMaster) {
                    let lowerId = id.toLowerCase();
                    masterMap[lowerId] = rawMaster[id];
                }
                Chat.log(`§b[系统] 读取总库，共 ${Object.keys(masterMap).length} 个物品`);
            }
        } catch(e) { Chat.log(`§c[警告] 读取总库失败: ${e}`); }
        
        for (let id in physicalMap) { 
            finalMap[id] = { name: physicalMap[id], flag: 1 }; 
        }
        
        let needCraft = 0;
        for (let id in masterMap) { 
            if (!finalMap.hasOwnProperty(id)) {
                let itemName = typeof masterMap[id] === 'object' ? masterMap[id].name : masterMap[id];
                finalMap[id] = { name: itemName, flag: 0 };
                needCraft++;
                Chat.log(`§7[待制作] ${itemName} (${id})`);
            }
        }
        
        forceSaveJson(finalMap, targetPath);
        Chat.log(`§a[完成] ${taskName} 扫描完成！`);
        Chat.log(`§a  - 已有样板: ${Object.keys(physicalMap).length} 个`);
        Chat.log(`§a  - 需要制作: ${needCraft} 个`);
    } else {
        let cleanedMap = {};
        for (let id in physicalMap) {
            cleanedMap[id.toLowerCase()] = physicalMap[id];
        }
        forceSaveJson(cleanedMap, targetPath);
        Chat.log(`§a[完成] ${taskName} 扫描完成，共 ${Object.keys(physicalMap).length} 个物品`);
    }
}

// ======================== 物品记录与删除功能 ========================

function getUnderMouseSlot() {
    let underMouseSlot = -999;
    let inventory = Player.openInventory();
    if (!inventory) return -999;
    try {
        underMouseSlot = inventory.getSlotUnderMouse();
    } catch (e) {}
    return underMouseSlot;
}

function recordItemToNowExisting(slot) {
    let inv = Player.openInventory();
    if (!inv) {
        Chat.log("§c[记录] 未打开任何容器界面");
        return;
    }
    
    let item = inv.getSlot(slot);
    if (!item || item.isEmpty()) {
        Chat.log(`§c[记录] 槽位 ${slot} 为空，无法记录`);
        return;
    }
    
    let itemId = getRealId(item).toLowerCase();
    let itemName = item.getName().getString().replace(/§./g, "");
    
    let existingMap = {};
    try {
        if (FS.exists(SAVE_PATH)) {
            let rawData = JSON.parse(FS.open(SAVE_PATH).read());
            for (let id in rawData) {
                let lowerId = id.toLowerCase();
                existingMap[lowerId] = rawData[id];
            }
        }
    } catch(e) {}
    
    if (existingMap[itemId]) {
        Chat.log(`§e[记录] 物品已存在当前库中: ${itemName} (${itemId})`);
        Chat.actionbar(`§e已存在: ${itemName}`);
        return;
    }
    
    existingMap[itemId] = { name: itemName, flag: 0 };
    
    try {
        let file = new File(SAVE_PATH);
        if (!file.getParentFile().exists()) file.getParentFile().mkdirs();
        let osw = new (Java.type("java.io.OutputStreamWriter"))(new (Java.type("java.io.FileOutputStream"))(file, false), "UTF-8");
        osw.write(JSON.stringify(existingMap, null, 2));
        osw.close();
        
        Chat.log(`§a[记录] 已添加: ${itemName} (${itemId}) 到当前库 (flag=0，待制作)`);
        Chat.actionbar(`§a已记录: ${itemName}`);
    } catch (e) {
        Chat.log(`§c[错误] 保存失败: ${e}`);
    }
}

function deleteItemFromNowExisting(slot) {
    let inv = Player.openInventory();
    if (!inv) {
        Chat.log("§c[删除] 未打开任何容器界面");
        return;
    }
    
    let item = inv.getSlot(slot);
    if (!item || item.isEmpty()) {
        Chat.log(`§c[删除] 槽位 ${slot} 为空，无法删除`);
        return;
    }
    
    let itemId = getRealId(item).toLowerCase();
    let itemName = item.getName().getString().replace(/§./g, "");
    
    let existingMap = {};
    try {
        if (FS.exists(SAVE_PATH)) {
            let rawData = JSON.parse(FS.open(SAVE_PATH).read());
            for (let id in rawData) {
                let lowerId = id.toLowerCase();
                existingMap[lowerId] = rawData[id];
            }
        }
    } catch(e) {}
    
    if (!existingMap[itemId]) {
        Chat.log(`§e[删除] 物品不存在当前库中: ${itemName} (${itemId})`);
        Chat.actionbar(`§e不存在: ${itemName}`);
        return;
    }
    
    delete existingMap[itemId];
    
    try {
        let file = new File(SAVE_PATH);
        if (!file.getParentFile().exists()) file.getParentFile().mkdirs();
        let osw = new (Java.type("java.io.OutputStreamWriter"))(new (Java.type("java.io.FileOutputStream"))(file, false), "UTF-8");
        osw.write(JSON.stringify(existingMap, null, 2));
        osw.close();
        
        Chat.log(`§c[删除] 已移除: ${itemName} (${itemId}) 从当前库`);
        Chat.actionbar(`§c已删除: ${itemName}`);
    } catch (e) {
        Chat.log(`§c[错误] 删除失败: ${e}`);
    }
}

// ======================== 核心逻辑：自动制作 ========================

function runAutoCraft() {
    isCrafting = true;
    
    try {
        let currentMap = {};
        try {
            if (!FS.exists(SAVE_PATH)) { Chat.log("§c[错误] 请先进行同步样板"); return; }
            let rawData = JSON.parse(FS.open(SAVE_PATH).read());
            for (let id in rawData) {
                let lowerId = id.toLowerCase();
                currentMap[lowerId] = rawData[id];
            }
        } catch (e) { Chat.log("§c[异常] 读取失败: " + e); return; }

        let missingIds = Object.keys(currentMap).filter(id => currentMap[id].flag === 0);
        if (missingIds.length === 0) { Chat.log("§a[完成] 无需制作样板。"); return; }
        
        Chat.log(`§b[系统] §f开始制作，共需制作 ${missingIds.length} 个样板`);
        let completed = 0;
        let skipped = 0;

        for (let targetId of missingIds) {
            if (!GlobalVars.getBoolean(SCRIPT_ID)) break;
            
            Chat.actionbar(`§e进度: ${completed + skipped + 1}/${missingIds.length} | 已完成: ${completed} | 跳过: ${skipped}`);

            let currentInv = Player.openInventory();
            if (!currentInv || !currentInv.getContainerTitle().replace(/§./g, "").includes(WORKBENCH_TITLE)) {
                Chat.log(`§c[错误] 不在样板工作台界面，停止制作`);
                break;
            }

            if (targetId.toLowerCase().startsWith("minecraft:")) {
                Chat.log(`§e[跳过] §7原版物品无需制作: §f${currentMap[targetId].name}`);
                currentMap[targetId].flag = 1;
                forceSaveJson(currentMap, SAVE_PATH);
                skipped++;
                Client.waitTick(DELAY.SAVE);
                continue; 
            }

            let itemName = currentMap[targetId].name;
            let inv = Player.openInventory();
            if (!inv || !inv.getContainerTitle().replace(/§./g, "").includes(WORKBENCH_TITLE)) break;

            if (inv.getSlot(41).isEmpty()) {
                Chat.log(`§b[系统] §f检测到空白样板缺失，正在从背包补给...`);
                let containerSize = inv.getTotalSlots() - 36;
                let foundBlank = false;
                for (let i = containerSize; i < inv.getTotalSlots(); i++) {
                    let item = inv.getSlot(i);
                    if (item && !item.isEmpty() && (item.getName().getString().includes("空白样板") || getRealId(item) === "slimefun:ae_blank_pattern")) {
                        inv.click(i); 
                        Client.waitTick(DELAY.CLICK);
                        inv.click(41); 
                        Client.waitTick(DELAY.CLICK);
                        foundBlank = true;
                        Chat.log(`§a[系统] 已补充空白样板至41槽`);
                        break;
                    }
                }
                if (!foundBlank) { 
                    Chat.log("§c[错误] 背包中缺少空白样板，制作停止！"); 
                    break; 
                }
            }

            inv.click(40);
            Client.waitTick(DELAY.CLICK);
            if (!waitForTitle("指南", 60)) continue;

            inv = Player.openInventory();
            inv.click(7);
            Client.waitTick(DELAY.CLICK);
            
            Chat.say(itemName);
            Client.waitTick(DELAY.SEARCH);

            if (!waitForTitle("你正在搜索", 100)) {
                pendingCloseScreen = true;
                Client.waitTick(5);
                Client.waitTick(DELAY.SWITCH);
                continue;
            }
            
            let targetSlot = -1;
            let searchTicks = 0;
            while (searchTicks < 20 && targetSlot === -1) {
                let sInv = Player.openInventory();
                if (!sInv || !sInv.getContainerTitle().includes("你正在搜索")) break;
                for (let s = 9; s <= 17; s++) {
                    let item = sInv.getSlot(s);
                    if (item && !item.isEmpty()) {
                        let slotItemName = item.getName().getString().replace(/§./g, "");
                        let slotItemId = getRealId(item).toLowerCase();
                        let targetItemName = itemName.replace(/§./g, "");
                        
                        // 精确匹配ID 或 中文名匹配
                        if (slotItemId === targetId.toLowerCase() || 
                            slotItemName === targetItemName) {
                            targetSlot = s; 
                            break;
                        }
                    }
                }
                if (targetSlot === -1) { 
                    Client.waitTick(2); 
                    searchTicks++; 
                }
            }

            if (targetSlot !== -1) {
                inv = Player.openInventory();
                inv.click(targetSlot);
                Client.waitTick(DELAY.CLICK);
                
                if (waitForTitle(WORKBENCH_TITLE, 80)) {
                    Client.waitTick(DELAY.SWITCH);
                    let finalInv = Player.openInventory();
                    let product = finalInv.getSlot(43);
                    if (product && !product.isEmpty()) {
                        finalInv.dropSlot(43, true);
                        Client.waitTick(DELAY.DROP);
                        Chat.actionbar(`§a已制作并丢弃: §f${itemName}`);
                        currentMap[targetId].flag = 1;
                        forceSaveJson(currentMap, SAVE_PATH);
                        completed++;
                        Client.waitTick(DELAY.SAVE);
                    }
                }
            } else {
                Chat.log(`§e[跳过] 未匹配: ${itemName} (${targetId})`);
                
                if (currentTickListener) {
                    try { 
                        JsMacros.off(currentTickListener); 
                    } catch(e) {}
                    currentTickListener = null;
                }
                
                pendingCloseScreen = true;
                Client.waitTick(10);
                
                currentMap[targetId].flag = 1;
                forceSaveJson(currentMap, SAVE_PATH);
                skipped++;
                Chat.log(`§7[信息] 已标记跳过，继续下一个 (跳过数: ${skipped})`);
                
                Client.waitTick(DELAY.SWITCH);
                Client.waitTick(5);
                
                Chat.log(`§b[系统] §f正在搜索附近的海晶石砖...`);
                let nearbyBlocks = getNearbyBlocks("minecraft:prismarine_bricks");
                
                let foundWorkbench = false;
                for (const [x, y, z] of nearbyBlocks) {
                    Chat.log(`§7[调试] 尝试打开海晶石砖 @ ${x}, ${y}, ${z}`);
                    
                    if (!openContainer(x, y, z)) {
                        Chat.log(`§c无法打开容器 @ ${x}, ${y}, ${z}`);
                        continue;
                    }
                    
                    Client.waitTick(10);
                    
                    if (waitForTitle(WORKBENCH_TITLE, 40)) {
                        Chat.log(`§a已成功打开样板工作台 @ ${x}, ${y}, ${z}`);
                        foundWorkbench = true;
                        break;
                    } else {
                        Chat.log(`§e该方块不是样板工作台，继续搜索...`);
                        pendingCloseScreen = true;
                        Client.waitTick(5);
                    }
                }
                
                if (!foundWorkbench) {
                    Chat.log(`§c[错误] 未找到附近的样板工作台，停止制作`);
                    break;
                }
                
                Client.waitTick(DELAY.CLICK);
            }
        }
        
        Chat.log(`§a[完成] 制作结束！成功: ${completed} | 跳过: ${skipped} | 总计: ${missingIds.length}`);
    } finally {
        isCrafting = false;
        pendingCloseScreen = false;
    }
}

// ======================== 辅助函数 ========================

function getRealId(item) {
    if (!item || item.isEmpty()) return null;
    
    try {
        let lore = item.getLore();
        if (lore) {
            for (let line of lore) {
                let lineStr = line.getString();
                let match = lineStr.match(/slimefun:[a-z0-9_]+/i);
                if (match) {
                    let slimefunId = match[0].toLowerCase();
                    return slimefunId;
                }
            }
        }
    } catch(e) {}
    
    try {
        let nbt = item.getNBT();
        if (nbt && nbt.has("minecraft:custom_data")) {
            let pbv = nbt.get("minecraft:custom_data").get("PublicBukkitValues");
            if (pbv && pbv.has("slimefun:slimefun_item")) {
                let slimefunId = "slimefun:" + pbv.get("slimefun:slimefun_item").asString();
                return slimefunId.toLowerCase();
            }
        }
    } catch(e) {}
    
    return String(item.getItemId()).toLowerCase();
}

function waitForTitle(keyword, timeout) {
    for (let i = 0; i < timeout; i++) {
        let inv = Player.openInventory();
        if (inv && inv.getContainerTitle().replace(/§./g, "").includes(keyword)) return true;
        Client.waitTick(2);
    }
    return false;
}

function generateFingerprint(inv) {
    let sign = "";
    for (let j = 0; j < 18; j++) {
        let itm = inv.getSlot(j);
        sign += (itm && !itm.isEmpty()) ? itm.getItemId() + itm.getCount() : "E";
    }
    return sign;
}

function autoFillPatterns(inv) {
    let existingMap = {};
    let currentMap = {};
    try { 
        if (FS.exists(SAVE_PATH)) {
            let data = JSON.parse(FS.open(SAVE_PATH).read());
            for (let k in data) {
                let lowerId = k.toLowerCase();
                currentMap[lowerId] = data[k];
                if (data[k].flag === 1) existingMap[lowerId] = true;
            }
        }
    } catch (e) { return; }
    
    let containerSize = inv.getTotalSlots() - 36;
    
    let patternsPlaced = 0;
    let patternsDiscarded = 0;
    let maxPatterns = containerSize;
    
    Chat.log(`§b[系统] §f开始处理样板，接口容量: ${maxPatterns} 槽`);
    
    for (let p = containerSize; p < inv.getTotalSlots(); p++) {
        let pItem = inv.getSlot(p);
        if (pItem && !pItem.isEmpty()) {
            let realId = getRealId(pItem);
            let itemName = pItem.getName().getString();
            
            let isEncodedPattern = false;
            let targetId = null;
            
            if (itemName.includes("编码样板") && !itemName.includes("编码样板槽位")) {
                isEncodedPattern = true;
                Chat.log(`§8[调试] 通过名称识别为成品样板: ${itemName}`);
            }
            
            if (!isEncodedPattern && realId && realId.toLowerCase() === "slimefun:ae_encoded_pattern") {
                isEncodedPattern = true;
                Chat.log(`§8[调试] 通过粘液ID识别为成品样板: ${realId}`);
            }
            
            if (isEncodedPattern) {
                try { 
                    targetId = pItem.getNBT().get("minecraft:custom_data").get("PublicBukkitValues").get("slimefun:ae_mn_encoded_pattern_output").asString();
                    if (targetId) {
                        targetId = "slimefun:" + targetId.toLowerCase();
                    }
                } catch(e) {
                    try {
                        let lore = pItem.getLore();
                        if (lore) {
                            for (let line of lore) {
                                let lineStr = line.getString();
                                let match = lineStr.match(/slimefun:[a-z0-9_]+/i);
                                if (match) {
                                    targetId = match[0].toLowerCase();
                                    break;
                                }
                            }
                        }
                    } catch(e2) {}
                }
                
                let itemName_display = "未知物品";
                if (targetId && currentMap[targetId]) {
                    itemName_display = currentMap[targetId].name;
                } else if (!targetId) {
                    itemName_display = "无法识别ID的样板";
                }
                
                if (targetId && existingMap[targetId]) { 
                    Chat.log(`§e[丢弃] 已存在样板: ${itemName_display} (${targetId})`);
                    inv.dropSlot(p, true); 
                    Client.waitTick(DELAY.DROP);
                    patternsDiscarded++;
                } 
                else { 
                    let empty = findInterfaceEmptySlot(inv, containerSize); 
                    if (empty !== -1 && patternsPlaced < maxPatterns) { 
                        Chat.log(`§a[存入] 新样板 → 槽位 ${empty}`);
                        
                        inv.click(p);
                        Client.waitTick(3);
                        
                        inv.click(empty);
                        Client.waitTick(3);
                        
                        patternsPlaced++;
                        
                        inv = Player.openInventory();
                        if (!inv || !inv.getContainerTitle().replace(/§./g, "").includes(INTERFACE_TITLE)) {
                            Chat.log(`§c[错误] 界面已关闭，停止存入`);
                            break;
                        }
                        containerSize = inv.getTotalSlots() - 36;
                    } else if (patternsPlaced >= maxPatterns) {
                        Chat.log(`§e[提示] 接口已满，无法存入更多样板`);
                        break;
                    } else {
                        Chat.log(`§c[错误] 接口中没有空槽位，无法存入样板`);
                        break;
                    }
                }
            }
        }
    }
    
    Chat.log(`§a[完成] 样板处理结束！存入: ${patternsPlaced} 个 | 丢弃: ${patternsDiscarded} 个`);
}

function findInterfaceEmptySlot(inv, size) {
    for (let i = 0; i < size; i++) {
        let item = inv.getSlot(i);
        if (item && !item.isEmpty()) {
            let itemName = item.getName().getString();
            let realId = getRealId(item);
            
            if (itemName.includes("编码样板槽位") || 
                (realId && realId.includes("_ae_mn_pattern_")) ||
                realId === "minecraft:green_stained_glass_pane") {
                return i;
            }
        }
    }
    return -1;
}

function forceSaveJson(data, path) {
    try {
        let file = new File(path);
        if (!file.getParentFile().exists()) file.getParentFile().mkdirs();
        let osw = new (Java.type("java.io.OutputStreamWriter"))(new (Java.type("java.io.FileOutputStream"))(file, false), "UTF-8");
        osw.write(JSON.stringify(data, null, 2));
        osw.close();
    } catch (e) { }
}

// ======================== 方块搜索与交互函数 ========================

function getNearbyBlocks(blockId) {
    let me = Player.getPlayer();
    let playerLocation = me.getPos();

    let block_list = World.getWorldScanner()
        .withStringBlockFilter()
        .contains(blockId)
        .build()
        .scanAroundPlayer(2);

    block_list = String(block_list);
    const numbers = block_list.slice(1, -1).split(", ").map(Number);

    const coordinates = [];
    for (let i = 0; i < numbers.length; i += 3) {
        coordinates.push([
            numbers[i],
            numbers[i + 1],
            numbers[i + 2],
        ]);
    }

    const filteredBlocks = coordinates.filter(([x, y, z]) => {
        const dx = Math.abs(x - playerLocation.x);
        const dy = Math.abs(y - playerLocation.y);
        const dz = Math.abs(z - playerLocation.z);
        return dx + dy + dz <= 7;
    });

    return filteredBlocks;
}

function openContainer(x, y, z) {
    try {
        let block = World.getBlock(x, y, z);
        if (block) {
            Player.getPlayer().interactBlock(x, y, z, "up", false);
            return true;
        }
    } catch (e) {
        Chat.log(`§c打开容器失败: ${e}`);
    }
    return false;
}

// 主循环
while (GlobalVars.getBoolean(SCRIPT_ID)) { 
    Client.waitTick(1); 
}