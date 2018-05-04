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

import * as util from './util';

/**
 * Imports the symbols in the given library into the current
 * document, and swaps any local symbols with the library versions.
 */
export function swapLocalSymbolsWithLibrary(document, library) {
  let librariesController = NSApp.delegate().librariesController();

  let symbolInfosByObjectId = {};

  // gather up a list of all available symbols in the library
  util.arrayFromNSArray(library.document().localSymbols()).forEach(localSymbol => {
    let objectId = String(localSymbol.objectID());
    let localSymbolId = String(localSymbol.symbolID());
    symbolInfosByObjectId[objectId] = {
      objectId,
      localSymbol,
      localSymbolId,
    };
  });

  // gather up all symbol masters used on this page that are in the library
  let symbolMastersToReplace = [];
  util.arrayFromNSArray(document.pages()).forEach(page => {
    util.walkLayerTree(page, layer => {
      if (!(layer instanceof MSSymbolMaster)) {
        return;
      }

      let symbolMaster = layer;
      let objectId = String(symbolMaster.objectID());
      if (!(objectId in symbolInfosByObjectId)) {
        return;
      }

      // found a symbol master in the library
      symbolMastersToReplace.push(symbolMaster);

      // if it's used in the doc, flag it for import
      if (util.arrayFromNSArray(symbolMaster.allInstances()).length) {
        symbolInfosByObjectId[objectId].shouldImport = true;
      }
    });
  });

  // import library symbols used in this document and create mapping from
  // local symbol to foreign symbol ID
  let localToForeignSymbolIdMap = {};
  Object.values(symbolInfosByObjectId).forEach(symbolInfo => {
    if (!symbolInfo.shouldImport) {
      return;
    }

    // import the symbol!
    symbolInfo.foreignSymbol = librariesController.importForeignSymbol_fromLibrary_intoDocument(
        symbolInfo.localSymbol, library, document.documentData());
    localToForeignSymbolIdMap[symbolInfo.localSymbolId] =
        String(symbolInfo.foreignSymbol.symbolMaster().symbolID());
  });

  // Replace all symbol masters used in the doc
  symbolMastersToReplace.forEach(masterToReplace => {
    let objectId = String(masterToReplace.objectID());
    let info = symbolInfosByObjectId[objectId];

    if (info.shouldImport) {
      // kill the local symbol, swap instances with foreign version
      replaceSymbolMaster(
          masterToReplace,
          info.foreignSymbol.symbolMaster(),
          localToForeignSymbolIdMap);
    }

    // finally, remove the local symbol
    masterToReplace.removeFromParent();
  });
}


/**
 * Resets all instances of the 'from' master to the 'to' master.
 *
 * @param {MSSymbolMaster} masterFrom
 * @param {MSSymbolMaster} masterTo
 * @param {dictionary} overridesIdMapToUpdate
 */
function replaceSymbolMaster(masterFrom, masterTo, overridesIdMapToUpdate = null) {
  util.arrayFromNSArray(masterFrom.allInstances()).forEach(instance => {
    instance.changeInstanceToSymbol(masterTo);
    if (overridesIdMapToUpdate) {
      //MSLayerPaster.updateOverridesOnInstance_withIDMap_(instance, overridesIdMapToUpdate);
      instance.updateOverridesWithObjectIDMap(overridesIdMapToUpdate);
    }
  });
}


/**
 * Returns the MSAssetLibrary / MSUserAssetLibrary with the given library ID
 * (which is a UUID)
 */
export function getLibraryById(libraryId) {
  let librariesController = NSApp.delegate().librariesController();
  return util.arrayFromNSArray(librariesController.libraries())
      .find(lib => String(lib.libraryID()) == libraryId);
}


/**
 * Adds the given .sketch file as a library in Sketch.
 */
export function addLibrary(context, librarySketchFilePath) {
  NSApp.delegate().librariesController().addAssetLibraryAtURL(
      NSURL.fileURLWithPath(librarySketchFilePath));
  // TODO: fix the library not showing up in the preferences pane until sketch restart
  AppController.sharedInstance().librariesController().notifyLibraryChange(null);
  // var libPaneIdentifier = MSAssetLibrariesPreferencePane.identifier();
  // var libPane = MSPreferencesController.sharedController().preferencePanes().objectForKey(libPaneIdentifier);
  // libPane.tableView().reloadData();
}


/**
 * Replaces all symbol instances under (and including) the given parent layer with
 * those found in the given MSAssetLibrary.
 */
export function replaceSymbolsInLayerWithLibrary(parentDocumentData, parentLayer, library) {
  if (parentLayer.children) {
    let allSymbolInstances = parentLayer.children()
        .filteredArrayUsingPredicate(NSPredicate.predicateWithFormat('className == %@', 'MSSymbolInstance'));

    // TODO: for symbols in a library that's nested within the given library, import from
    // that library instead of the given library

    let maybeImportForeignSymbolWithSymbolId = symbolId => {
      let librarySymbolMaster = library.symbolWithID(symbolId);
      if (librarySymbolMaster) {
        let librariesController = AppController.sharedInstance().librariesController();
        let foreignSymbol = librariesController.importForeignSymbol_fromLibrary_intoDocument(
            librarySymbolMaster, library, parentDocumentData);
        return foreignSymbol;
      }

      return null;
    };

    allSymbolInstances.forEach(symbolInstance => {
      let symbolId = symbolInstance.symbolID();
      let foreignSymbol = maybeImportForeignSymbolWithSymbolId(symbolId);
      if (foreignSymbol) {
        symbolInstance.changeInstanceToSymbol(foreignSymbol.symbolMaster());
      }

      let localToForeignSymbolIdMap = {};
      for (let [overrideId, overrideDict] of Object.entries({...symbolInstance.overrides()})) {
        if (overrideDict.symbolID) {
          let foreignSymbol = maybeImportForeignSymbolWithSymbolId(overrideDict.symbolID);
          if (foreignSymbol) {
            // swap out the symbol ID that's local to the library for the symbol ID
            // for the foreign symbol in the new document linked to the library
            localToForeignSymbolIdMap[String(overrideDict.symbolID)] =
                String(foreignSymbol.symbolMaster().symbolID());
          }
        }
      }
      symbolInstance.updateOverridesWithObjectIDMap(localToForeignSymbolIdMap);
    });
  }
}


/**
 * Returns an MSDocument for the library with the given ID (cached).
 * Note: this operation may take a while.
 */
export function docForLibraryId(libraryId) {
  docForLibraryId.__cache__ = docForLibraryId.__cache__ || {};
  if (!(libraryId in docForLibraryId.__cache__)) {
    let library = Array.from(NSApp.delegate().librariesController().libraries())
        .find(lib => String(lib.libraryID()) == libraryId);
    if (!library) {
      return null;
    }

    docForLibraryId.__cache__[libraryId] = utils.loadDocFromSketchFile(
        String(library.locationOnDisk().path()));
  }

  return docForLibraryId.__cache__[libraryId];
}
