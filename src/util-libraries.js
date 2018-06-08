import * as util from './util';

/**
 * Imports the symbols in the given library into the current
 * document, and swaps any local symbols with the library versions.
 */
export function swapLocalSymbolsWithLibrary(document, library) {
  let librariesController = getLibrariesController();

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
  let allSymbolMasters = util.getAllLayersMatchingPredicate(document,
      NSPredicate.predicateWithFormat('className == %@', 'MSSymbolMaster'));
  allSymbolMasters.forEach(symbolMaster => {
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

  // import library symbols used in this document and create mapping from
  // local symbol to foreign symbol ID
  let localToForeignSymbolIdMap = {};
  Object.values(symbolInfosByObjectId).forEach(symbolInfo => {
    if (!symbolInfo.shouldImport) {
      return;
    }

    // import the symbol!
    symbolInfo.foreignSymbol = importForeignSymbolCompat(
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
  return util.arrayFromNSArray(getLibrariesController().libraries())
      .find(lib => String(lib.libraryID()) == libraryId);
}


/**
 * Adds the given .sketch file as a library in Sketch.
 */
export function addLibrary(context, librarySketchFilePath) {
  getLibrariesController().addAssetLibraryAtURL(NSURL.fileURLWithPath(librarySketchFilePath));
  getLibrariesController().notifyLibraryChange(
      getLibrariesController().userLibraries().firstObject()); // notify change on any lib
}


/**
 * Replaces all symbol instances under (and including) the given parent layer with
 * those found in the given MSAssetLibrary.
 */
export function replaceSymbolsInLayerWithLibrary(parentDocument, parentLayer, library) {
  if (parentLayer.children) {
    let allSymbolInstances =  util.getAllLayersMatchingPredicate(
        parentLayer, NSPredicate.predicateWithFormat('className == %@', 'MSSymbolInstance'));

    // TODO: for symbols in a library that's nested within the given library, import from
    // that library instead of the given library

    let maybeImportForeignSymbolWithSymbolId = symbolId => {
      let librarySymbolMaster = library.document().symbolWithID(symbolId);
      if (librarySymbolMaster) {
        return importForeignSymbolCompat(librarySymbolMaster, library,
            parentDocument.documentData());
      }

      return null;
    };

    // Imports an override dictionary of the form:
    //
    // { 'symbolID': '123',
    //   '456': { 'symbolID': '789', ... },
    //   ...  }
    //
    // This is necessary when importing override symbols that themselves have overrides
    let deepImportOverrides = (dict, localToForeignSymbolIdMap) => {
      if (dict.symbolID) {
        let foreignSymbol = maybeImportForeignSymbolWithSymbolId(dict.symbolID);
        if (foreignSymbol) {
          // swap out the symbol ID that's local to the library for the symbol ID
          // for the foreign symbol in the new document linked to the library
          localToForeignSymbolIdMap[String(dict.symbolID)] =
              String(foreignSymbol.symbolMaster().symbolID());
        }
      }

      for (let k in dict) {
        if (dict[k].symbolID) {
          deepImportOverrides(dict[k], localToForeignSymbolIdMap);
        }
      }
    };

    allSymbolInstances.forEach(symbolInstance => {
      let symbolId = symbolInstance.symbolID();
      let foreignSymbol = maybeImportForeignSymbolWithSymbolId(symbolId);
      if (foreignSymbol) {
        symbolInstance.changeInstanceToSymbol(foreignSymbol.symbolMaster());
      }

      let localToForeignSymbolIdMap = {};
      for (let [overrideId, overrideDict] of Object.entries({...symbolInstance.overrides()})) {
        deepImportOverrides(overrideDict, localToForeignSymbolIdMap);
      }

      symbolInstance.updateOverridesWithObjectIDMap(localToForeignSymbolIdMap);
    });
  }
}


/**
 * /**
 * Compatibility layer for importForeignSymbol_fromLibrary_intoDocument,
 * removed in Sketch 50.
 *
 * @param {MSSymbolMaster} librarySymbolMaster The symbol master in the library to import
 * @param {MSAssetLibrary} library The library to import from
 * @param {MSDocumentData} parentDocumentData The document data to import into
 * @returns {MSForeignSymbol}
 */
function importForeignSymbolCompat(librarySymbolMaster, library, parentDocumentData) {
  let librariesController = getLibrariesController();
  if (librariesController.importForeignSymbol_fromLibrary_intoDocument) {
    // Sketch < 50
    return librariesController.importForeignSymbol_fromLibrary_intoDocument(
        librarySymbolMaster, library, parentDocumentData);
  } else {
    // Sketch 50
    let shareableObjectReference = MSShareableObjectReference.referenceForShareableObject_inLibrary(
        librarySymbolMaster, library);
    return librariesController.importShareableObjectReference_intoDocument(
        shareableObjectReference, parentDocumentData);
  }
}


/**
 * Returns an MSDocument for the library with the given ID (cached).
 * Note: this operation may take a while.
 */
export function docForLibraryId(libraryId) {
  docForLibraryId.__cache__ = docForLibraryId.__cache__ || {};
  if (!(libraryId in docForLibraryId.__cache__)) {
    let library = Array.from(getLibrariesController().libraries())
        .find(lib => String(lib.libraryID()) == libraryId);
    if (!library) {
      return null;
    }

    docForLibraryId.__cache__[libraryId] = utils.loadDocFromSketchFile(
        String(library.locationOnDisk().path()));
  }

  return docForLibraryId.__cache__[libraryId];
}


/**
 * Gets the app instance's MSAssetLibraryController
 */
function getLibrariesController() {
  return AppController.sharedInstance().librariesController();
}
