/*
 * Copyright (c) 2021 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { createBlocklistFilter } from "./radixTrie.js";
import { BlocklistFilter } from "./blocklistFilter.js";
import * as bufutil from "../../commons/bufutil.js";
import * as util from "../../commons/util.js";

class BlocklistWrapper {
  constructor() {
    this.blocklistFilter = new BlocklistFilter();
    this.td = null; // trie
    this.rd = null; // rank-dir
    this.ft = null; // file-tags
    this.startTime = 0; // blocklist download timestamp
    this.isBlocklistUnderConstruction = false;
    this.exceptionFrom = "";
    this.exceptionStack = "";
    this.log = log.withTags("BlocklistWrapper");
  }

  /**
   * @param {*} param
   * @param {String} param.blocklistUrl
   * @param {String} param.latestTimestamp
   * @param {Number} param.workerTimeout
   * @param {Number} param.tdParts
   * @param {Number} param.tdNodecount
   * @param {Number} param.fetchTimeout
   * @returns
   */
  async RethinkModule(param) {
    let response = util.emptyResponse();

    if (this.isBlocklistFilterSetup()) {
      response.data.blocklistFilter = this.blocklistFilter;
      return response;
    }

    try {
      const now = Date.now();

      if (
        !this.isBlocklistUnderConstruction ||
        // it has been a while, queue another blocklist-construction
        now - this.startTime > param.workerTimeout * 2
      ) {
        return await this.initBlocklistConstruction(
          param.rxid,
          now,
          param.blocklistUrl,
          param.latestTimestamp,
          param.tdNodecount,
          param.tdParts
        );
      } else {
        // someone's constructing... wait till finished
        // res.arrayBuffer() is the most expensive op, taking anywhere
        // between 700ms to 1.2s for trie. But: We don't want all incoming
        // reqs to wait until the trie becomes available. 400ms is 1/3rd of
        // 1.2s and 2x 250ms; both of these values have cost implications:
        // 250ms (0.28GB-sec or 218ms wall time) in unbound usage per req
        // equals cost of one bundled req.
        let totalWaitms = 0;
        const waitms = 50;
        while (totalWaitms < param.fetchTimeout) {
          if (this.isBlocklistFilterSetup()) {
            response.data.blocklistFilter = this.blocklistFilter;
            return response;
          }
          await sleep(waitms);
          totalWaitms += waitms;
        }

        response.isException = true;
        response.exceptionStack =
          this.exceptionStack || "blocklist-filter timeout " + totalWaitms;
        response.exceptionFrom = this.exceptionFrom || "blocklistWrapper.js";
      }
    } catch (e) {
      this.log.e(param.rxid, "main", e);
      response = util.errResponse("blocklistWrapper", e);
    }

    return response;
  }

  isBlocklistFilterSetup() {
    return !util.emptyObj(this.blocklistFilter) && this.blocklistFilter.t;
  }

  initBlocklistFilterConstruction(td, rd, ft, config) {
    this.isBlocklistUnderConstruction = true;
    this.startTime = Date.now();
    const filter = createBlocklistFilter(
      /* trie*/ td,
      /* rank-dir*/ rd,
      /* file-tags*/ ft,
      /* basic-config*/ config
    );
    this.blocklistFilter.loadFilter(
      /* trie*/ filter.t,
      /* frozen-trie*/ filter.ft,
      /* basic-config*/ filter.blocklistBasicConfig,
      /* file-tags*/ filter.blocklistFileTag
    );
    this.isBlocklistUnderConstruction = false;
  }

  async initBlocklistConstruction(
    rxid,
    when,
    blocklistUrl,
    latestTimestamp,
    tdNodecount,
    tdParts
  ) {
    this.isBlocklistUnderConstruction = true;
    this.startTime = when;

    let response = util.emptyResponse();
    try {
      const bl = await this.downloadBuildBlocklist(
        rxid,
        blocklistUrl,
        latestTimestamp,
        tdNodecount,
        tdParts
      );

      this.blocklistFilter.loadFilter(
        bl.t,
        bl.ft,
        bl.blocklistBasicConfig,
        bl.blocklistFileTag
      );

      this.log.i(rxid, "done loading blocklist-filter");
      if (false) {
        // test
        const result = this.blocklistFilter.getDomainInfo("google.com");
        this.log.d(rxid, JSON.stringify(result));
      }

      response.data.blocklistFilter = this.blocklistFilter;
    } catch (e) {
      this.log.e(rxid, e);
      response = util.errResponse("initBlocklistConstruction", e);
      this.exceptionFrom = response.exceptionFrom;
      this.exceptionStack = response.exceptionStack;
    }

    this.isBlocklistUnderConstruction = false;

    return response;
  }

  async downloadBuildBlocklist(
    rxid,
    blocklistUrl,
    latestTimestamp,
    tdNodecount,
    tdParts
  ) {
    !tdNodecount && this.log.e(rxid, "tdNodecount zero or missing!");

    const resp = {};
    const baseurl = blocklistUrl + latestTimestamp;
    const blocklistBasicConfig = {
      nodecount: tdNodecount || -1,
      tdparts: tdParts || -1,
    };

    // filetag is fetched as application/octet-stream and so,
    // the response api complains it is unsafe to .json() it:
    // Called .text() on an HTTP body which does not appear to be
    // text. The body's Content-Type is "application/octet-stream".
    // The result will probably be corrupted. Consider checking the
    // Content-Type header before interpreting entities as text.
    const buf0 = fileFetch(baseurl + "/filetag.json", "json");
    const buf1 = makeTd(baseurl, blocklistBasicConfig.tdparts);
    const buf2 = fileFetch(baseurl + "/rd.txt", "buffer");

    const downloads = await Promise.all([buf0, buf1, buf2]);

    this.log.i(rxid, "call createBlocklistFilter", blocklistBasicConfig);

    this.td = downloads[1];
    this.rd = downloads[2];
    this.ft = downloads[0];

    const trie = createBlocklistFilter(
      /* trie*/ this.td,
      /* rank-dir*/ this.rd,
      /* file-tags*/ this.ft,
      /* basic-config*/ blocklistBasicConfig
    );

    resp.t = trie.t; // tags
    resp.ft = trie.ft; // frozen-trie
    resp.blocklistBasicConfig = blocklistBasicConfig;
    resp.blocklistFileTag = this.ft;
    return resp;
  }
}

async function fileFetch(url, typ) {
  if (typ !== "buffer" && typ !== "json") {
    throw new Error("Unknown conversion type at fileFetch");
  }

  log.i("downloading", url);
  const res = await fetch(url, { cf: { cacheTtl: /* 2w */ 1209600 } });

  if (!res.ok) {
    log.e(url, res);
    throw new Error(JSON.stringify([url, res, "fileFetch fail"]));
  }

  if (typ === "buffer") {
    return await res.arrayBuffer();
  } else if (typ === "json") {
    return await res.json();
  }
}

const sleep = (ms) => {
  return new Promise((resolve, reject) => {
    try {
      setTimeout(resolve, ms);
    } catch (e) {
      reject(e.message);
    }
  });
};

// joins split td parts into one td
async function makeTd(baseurl, n) {
  log.i("makeTd from tdParts", n);

  if (n <= -1) {
    return fileFetch(baseurl + "/td.txt", "buffer");
  }

  const tdpromises = [];
  for (let i = 0; i <= n; i++) {
    // td00.txt, td01.txt, td02.txt, ... , td98.txt, td100.txt, ...
    const f =
      baseurl +
      "/td" +
      i.toLocaleString("en-US", {
        minimumIntegerDigits: 2,
        useGrouping: false,
      }) +
      ".txt";
    tdpromises.push(fileFetch(f, "buffer"));
  }
  const tds = await Promise.all(tdpromises);

  log.i("tds downloaded");

  return new Promise((resolve, reject) => {
    try {
      resolve(bufutil.concat(tds));
    } catch (e) {
      reject(e.message);
    }
  });
}

export { BlocklistFilter, BlocklistWrapper };