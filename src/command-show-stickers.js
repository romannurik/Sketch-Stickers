/*
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

if (!global._babelPolyfill) {
	require('babel-polyfill');
}

import path from '@skpm/path';
import fs from '@skpm/fs';
import yaml from 'js-yaml';
import BrowserWindow from 'sketch-module-web-view';
import MochaJSDelegate from 'mocha-js-delegate';

import * as libraries from './util-libraries';
import * as util from './util';
import {ProgressReporter} from './util-progress-reporter';


const THREAD_DICT_KEY = 'stickers.BrowserWindow';
const INDEX_FORMAT_VERSION = 1;

const FORCE_REBULD = false;
const UI_MODE = 'cover';


export default function(context) {
  new StickersWindow(context);
}


class StickersWindow {
  constructor(context) {
    this.context = context;
    this.showHide();
  }


  /**
   * Shows or hides the Stickers window (if already shown).
   * The state is stored in the main thread's threadDictionary.
   */
  showHide() {
    let browserWindow = this.getPersistedObj();
    if (browserWindow) {
      browserWindow.close();
      this.setPersistedObj(null);
    } else {
      this.createAndShow();
    }
  }


  getPersistedObj() {
    let threadDict = NSThread.mainThread().threadDictionary();
    return threadDict[THREAD_DICT_KEY];
  }


  setPersistedObj(obj) {
    let threadDict = NSThread.mainThread().threadDictionary();
    if (obj) {
      threadDict[THREAD_DICT_KEY] = obj;
    } else {
      threadDict.removeObjectForKey(THREAD_DICT_KEY);
    }
  }


  runWebCallback(callbackName, ...args) {
    let js = (
        `window['${callbackName}'](` +
        args.map(arg => JSON.stringify(arg)).join(', ') +
        `);`);
    try {
      this.webContents.executeJavaScript(js);
    } catch (e) {
      log(e.message);
      log(e);
    }
  }


  createAndShow() {
    let docWindow = this.context.document.documentWindow();

    this.browserWindow = new BrowserWindow({
      backgroundColor: '#ffffffff',
      identifier: 'stickers.web',
      width: 800,
      height: 600,
      show: false,
      frame: UI_MODE == 'palette',
      hasShadow: UI_MODE == 'palette',
      acceptsFirstMouse: true,
    });

    this.webContents = this.browserWindow.webContents;
    this.setupWebAPI();

    this.browserWindow.on('closed', () => {
      this.setPersistedObj(null);
      coscript.setShouldKeepAround(false);
    });

    if (UI_MODE == 'cover') {
      this.browserWindow.setResizable(false);
      this.browserWindow._panel.setFrame_display_animate_(docWindow.frame(), false, false);
    }
    this.browserWindow.once('ready-to-show', () => this.browserWindow.show());
    this.browserWindow.loadURL(String(
        this.context.plugin.urlForResourceNamed('index.html') +
        `?uiMode=${UI_MODE}`));

    if (UI_MODE == 'cover') {
      docWindow.addChildWindow_ordered_(this.browserWindow._panel, NSWindowAbove);
    }
    this.setPersistedObj(this.browserWindow);
  }


  setupWebAPI() {
    this.webContents.on('loadStickerIndex', (callbackName, progressCallbackName) => {
      // trigger the creation of the sticker index
      this.makeStickerIndexForLibraries(
          {onProgress: progress => this.runWebCallback(progressCallbackName, progress)})
          .then(stickerIndex => this.runWebCallback(callbackName, stickerIndex));
    });

    this.webContents.on('openUrl', url => {
      NSWorkspace.sharedWorkspace().openURL(NSURL.URLWithString(url));
    });

    // add a handler for a call from web content's javascript
    this.webContents.on('close', () => this.browserWindow.close());

    this.webContents.on('requestLayerImageUrl', (stickerId, callbackName) => {
      let imagePath = this.getStickerCachedImagePath(stickerId);
      // let url = nsImageToDataUri(NSImage.alloc().initWithContentsOfFile(imagePath));
      let url = 'file://' + imagePath;
      this.runWebCallback(callbackName, stickerId, url);
    });

    // add a handler for a call from web content's javascript
    this.webContents.on('startDragging', (stickerId, rect) => {
      try {
        this.startDragging(stickerId, rect, this.browserWindow._webview);
      } catch (e) {
        // TODO: do this everywhere somehow
        log(e.message);
        log(e);
      }
      if (UI_MODE == 'cover') {
        this.browserWindow.close();
      }
    })
  }

  /**
   * Triggers the beginning of a drag operation on the given sticker ID
   */
  startDragging(stickerId, rect, srcView) {
    let [libraryId, layerId] = stickerId.split(/\./, 2);

    let library = libraries.getLibraryById(libraryId);
    let image = NSImage.alloc().initWithContentsOfFile(this.getStickerCachedImagePath(stickerId));

    // deserialize layer
    let serializedLayerJson = fs.readFileSync(
        this.getStickerCachedContentPath(stickerId), {encoding: 'utf8'});
    let decodedImmutableObj = MSJSONDataUnarchiver
        .unarchiveObjectWithString_asVersion_corruptionDetected_error(
            serializedLayerJson, 999, null, null);
    let layer = decodedImmutableObj.newMutableCounterpart();

    // create a dummy document and import the layer into it, so that
    // foreign symbols can be created in it and sent along with the layer
    // to the pasteboard
    let dummyDocData = MSDocumentData.alloc().init();
    dummyDocData.addBlankPage().addLayer(layer);

    // import any symbols used in library
    // TODO: for symbols in a different library, import from that library
    libraries.replaceSymbolsInLayerWithLibrary(dummyDocData, layer, library);

    // initiate cocoa drag operation
    let pbItem = NSPasteboardItem.new();
    pbItem.setDataProvider_forTypes_(
        srcView,
        NSArray.arrayWithObject(NSPasteboardTypePNG));
    let dragItem = NSDraggingItem.alloc().initWithPasteboardWriter(pbItem);
    pbItem.release();
    dragItem.setDraggingFrame_contents_(
        NSMakeRect(rect.x, rect.y, rect.width, rect.height),
        image);
    let mouse = NSEvent.mouseLocation();
    let event = NSEvent.eventWithCGEvent(CGEventCreateMouseEvent(
        null,
        kCGEventLeftMouseDown,
        CGPointMake(
            mouse.x - srcView.window().frame().origin.x,
            NSHeight(NSScreen.screens().firstObject().frame())
                - mouse.y + srcView.window().frame().origin.y),
        kCGMouseButtonLeft));
    let draggingSession = srcView.beginDraggingSessionWithItems_event_source_(
        NSArray.arrayWithObject(dragItem.autorelease()), event, srcView);
    draggingSession.setAnimatesToStartingPositionsOnCancelOrFail(false);
    draggingSession.setDraggingFormation(NSDraggingFormationNone);

    // copy to pasteboard
    let dpb = NSPasteboard.pasteboardWithName(NSDragPboard);
    dpb.clearContents();
    try {
      let newPbLayers = MSPasteboardLayers.pasteboardLayersWithLayers([layer]);
      MSPasteboardManager.writePasteboardLayers_toPasteboard(newPbLayers, dpb);
    } catch (err) {
      throw err;
    }
  }


  getStickerCachedImagePath(stickerId) {
    let [libraryId, layerId] = stickerId.split(/\./, 2);
    return path.join(util.getPluginCachePath(), libraryId, layerId + '.png');
  }


  getStickerCachedContentPath(stickerId) {
    let [libraryId, layerId] = stickerId.split(/\./, 2);
    return path.join(util.getPluginCachePath(), libraryId, layerId + '.json');
  }


  /**
   * Returns a sticker index JSON for the user's libraries, building and caching it
   * if needed.
   */
  async makeStickerIndexForLibraries({onProgress}) {
    let libraries = Array.from(NSApp.delegate().librariesController().libraries())
        .filter(lib => !!lib.locationOnDisk() && !!lib.enabled())
        .map(lib => ({
          // TODO: detect duplicate library IDs
          libraryId: String(lib.libraryID()),
          sketchFilePath: String(lib.locationOnDisk().path()),
        }));

    let progressReporter = new ProgressReporter();
    progressReporter.on('progress', progress => onProgress(progress));
    let childProgressReporters = progressReporter.makeChildren(libraries.length);

    // build indexes
    let compositeIndex = {sections: []};
    for (let [i, lib] of libraries.entries()) {
      await util.unpeg();

      // for this library, get the last modified date of the sketch file
      let modifiedDateMs = NSFileManager.defaultManager()
          .attributesOfItemAtPath_error_(lib.sketchFilePath, null)
          .fileModificationDate()
          .timeIntervalSince1970();

      let cachePath = path.join(util.getPluginCachePath(), lib.libraryId);

      let index = null;
      let indexCachePath = path.join(cachePath, 'index.json');

      try {
        index = JSON.parse(fs.readFileSync(indexCachePath, {encoding: 'utf8'}));
      } catch (e) {
      }

      if (FORCE_REBULD ||
          !index ||
          index.timestamp < modifiedDateMs ||
          index.version < INDEX_FORMAT_VERSION) {
        // need to rebuild the cached index
        let doc = util.loadDocFromSketchFile(lib.sketchFilePath);
        index = await this.buildStickerIndexForLibrary(
            lib.libraryId, doc, childProgressReporters[i]);

        // cache the index
        util.mkdirpSync(path.dirname(indexCachePath));
        fs.writeFileSync(indexCachePath,
            JSON.stringify(Object.assign(index, {
              version: INDEX_FORMAT_VERSION,
              timestamp: modifiedDateMs + 1, // add a second to avoid precision issues
            })),
            {encoding: 'utf8'});
      } else {
        childProgressReporters[i].forceProgress(1);
      }

      compositeIndex.sections = compositeIndex.sections.concat(index.sections || []);
    }

    return compositeIndex;
  }


  /**
   * Builds the sticker index for the given library (libraryId and document).
   */
  async buildStickerIndexForLibrary(libraryId, document, progressReporter) {
    let cachePath = path.join(util.getPluginCachePath(), libraryId);

    // first, find sticker sections (stored in text layers)
    let sectionsById = {};
    let sections = [];

    let allTextLayers = util.getAllLayersMatchingPredicate(
        document,
        NSPredicate.predicateWithFormat('className == %@', 'MSTextLayer'));
    allTextLayers.reverse(); // layer list order, not stacking order
    for (let textLayer of allTextLayers) {
      let text = textLayer.stringValue().replace(/[‘’]/g, `'`).replace(/[“”]/g, `"`);
      let stickerSections = text.split(/!StickerSection\s+/g).slice(1);
      for (let text of stickerSections) {
        let sectionIdMatch = text.match(/^@[\w\.]+$/igm);
        if (!sectionIdMatch) {
          continue;
        }

        let id = sectionIdMatch[0];
        let stickerSection = {title: id};

        try {
          stickerSection = Object.assign(
              stickerSection,
              yaml.safeLoad(text.substr(sectionIdMatch[0].length)),
              {id, items: [], type: 'section', libraryId});
        } catch (e) {
          log(`Error parsing sticker section YAML for ${id}`);
        }

        if (id in sectionsById) {
          log(`Duplicate sticker section id ${id}, skipping duplicates`);
        } else {
          sectionsById[id] = stickerSection;
          sections.push(stickerSection);
        }
      }
    }

    // nest sections
    for (let section of Array.from(sections)) {
      let parentId = section.id.substr(0, section.id.lastIndexOf('.'));
      if (parentId) {
        let parentSection = sectionsById[parentId];
        if (!parentSection) {
          log(`Unknown parent section ${parentId}`);
          continue;
        }

        parentSection.items = parentSection.items || [];
        parentSection.items.push(section);

        // remove from the root
        sections.splice(sections.indexOf(section), 1);
      }
    }

    // go through all layers tagged to a section
    let possibleStickers = util.getAllLayersMatchingPredicate(
        document,
        NSPredicate.predicateWithFormat('name matches ".*@.*"'));
    possibleStickers.reverse(); // layer list order, not stacking order
    progressReporter.total = possibleStickers.length;
    for (let layer of possibleStickers) {
      progressReporter.increment();
      let name = layer.name();
      let sectionMatch = name.match(/(.*?)\s*(@[\w\.]+)$/);
      if (!sectionMatch) {
        continue;
      }

      if (layer instanceof MSTextLayer && name.startsWith('!Sticker')) {
        continue;
      }

      let parentSectionId = sectionMatch[2];
      let parentSection = sectionsById[parentSectionId];
      if (!parentSection) {
        log(`Sticker section not found ${parentSectionId} for layer named ${name}`);
        continue;
      }

      let layerId = String(layer.objectID());
      let id = libraryId + '.' + layerId;
      let layerInfo = {
        type: 'layer',
        id,
        layer,
        name: sectionMatch[1],
        imagePath: path.join(cachePath, layerId + '.png'),
        contentPath: path.join(cachePath, layerId + '.json'),
        width: Number(layer.absoluteInfluenceRect().size.width),
        height: Number(layer.absoluteInfluenceRect().size.height),
      };

      // capture layer image
      util.captureLayerImage(document, layer, layerInfo.imagePath);

      // capture layer content
      let serializedLayer = JSON.parse(MSJSONDataArchiver.archiveStringWithRootObject_error_(
          layer.immutableModelObject(), null));
      fs.writeFileSync(layerInfo.contentPath, JSON.stringify(serializedLayer), {encoding: 'utf8'});

      parentSection.items = parentSection.items || [];
      parentSection.items.push(layerInfo);
      await util.unpeg();
    }

    // cull any sections that don't indirectly or directly contain stickers
    let nonEmptyItems = items => items.filter(item => {
      if (item.type == 'layer') {
        return true;
      } else if (item.type == 'section') {
        item.items = nonEmptyItems(item.items || []);
        return item.items.length > 0;
      }
    });

    sections = nonEmptyItems(sections);

    return {sections};
  }
}

