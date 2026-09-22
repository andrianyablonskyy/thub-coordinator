/**
 * @file        packages/coordinator/src/services/commands.js
 * @description In-memory per-resource command queue delivered via the heartbeat response (README §5.1)
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

'use strict';

// §5.1: "The commands[] field in the heartbeat response is how the
// Coordinator talks to a Client without an inbound connection." Pending
// commands are cheap and short-lived, so an in-memory queue per resource
// is enough — consistent with the single-process design (§3.1).
function createCommandsService({ bus }){
  const pending = new Map(); // resourceId -> [{command, jobId?, ...}]

  bus.on('command', ({ resourceId, ...command }) => {
    if (!pending.has(resourceId)){
      pending.set(resourceId, []);
    }
    pending.get(resourceId).push(command);
  });

  function drain(resourceId){
    const commands = pending.get(resourceId) || [];
    pending.delete(resourceId);
    return commands;
  }

  function push(resourceId, command){
    bus.emit('command', { resourceId, ...command });
  }

  return { drain, push };
}

module.exports = { createCommandsService };
