// Web (Emscripten) replacement for wspudp.cpp: the same UDPInterfaceClass, but packets travel over a
// browser WebSocket to a relay server instead of over UDP. A browser cannot send UDP or broadcast.
//
// The web page, not the game, connects to the relay and joins a room (so it can report errors such
// as "no such room" before the game starts). It then sets Module.vcnetPre = { ws, id, room }: an open
// WebSocket (binaryType "arraybuffer", relay hello already handled), our relay id 1..254, and the
// room code. The page deletes Module.vcnetPre when its socket closes. This file adopts that socket:
// it adds its own listener with addEventListener, never replaces the page's handlers, and never
// closes the socket (leaving the game's lobby leaves the player in the room).
//
// Relay wire protocol v0:
//   Text frames are for the page and are ignored here.
//   Binary frames to the relay: byte 0 = destination id (0 = everyone else in the room), then payload.
//   Binary frames from the relay: byte 0 = sender id, then payload. The relay never echoes.
//
// Relay id N is shown to the game as the IPv4 address 10.0.0.N (the game identifies a peer by
// its 4-byte address alone). Browser callbacks only queue data in JavaScript; the game drains the
// queue when it polls Message_Handler().

#ifdef __EMSCRIPTEN__

#include "wspudp.h"
#include "mssleep.h"
#include "wwkeyboard.h"
#include <emscripten.h>
#include <string.h>

extern WWKeyboardClass* Keyboard;

#ifdef NETWORKING

// clang-format off
// Adopt the page's open relay connection (Module.vcnetPre). Returns our relay id, or 0 if there is none.
EM_JS(int, vcnet_open, (void), {
    var pre = Module.vcnetPre;
    if (!pre || !pre.ws || pre.ws.readyState !== 1 || !(pre.id >= 1 && pre.id <= 254)) {
        console.log("vcnet: not in a room; use Create game or Join game on the page");
        return 0;
    }
    var ws = pre.ws;
    // Our listener reads Module.vcNet each time, so it is added only once per socket (marked by a flag).
    Module.vcNet = { ws: ws, q: [], id: pre.id, active: true };
    if (!ws.vcnetListening) {
        ws.vcnetListening = true;
        ws.addEventListener("message", function(ev) {
            var net = Module.vcNet;
            if (!net || net.ws !== ws || !net.active) return;
            if (typeof ev.data === "string") return; // text frames are for the page
            if (net.q.length < 4096) net.q.push(new Uint8Array(ev.data));
        });
    }
    console.log("vcnet: using room " + pre.room + " as id " + pre.id);
    return pre.id;
});

EM_JS(int, vcnet_send, (int dest, const unsigned char* data, int len), {
    var net = Module.vcNet;
    if (!net || !net.active || net.ws.readyState !== 1) return 0; // socket gone: drop quietly
    var frame = new Uint8Array(len + 1);
    frame[0] = dest;
    frame.set(HEAPU8.subarray(data, data + len), 1);
    net.ws.send(frame);
    return 1;
});

// Copy the oldest queued frame (sender id byte + payload) into buf. Returns its length, 0 if none.
EM_JS(int, vcnet_recv, (unsigned char* buf, int max), {
    var net = Module.vcNet;
    if (!net) return 0;
    while (net.q.length) {
        var f = net.q.shift();
        if (f.length < 2 || f.length > max) continue;
        HEAPU8.set(f, buf);
        return f.length;
    }
    return 0;
});

// Detach only: stop queueing and forget queued frames. The page's socket stays open.
EM_JS(void, vcnet_close, (void), {
    var net = Module.vcNet;
    if (net) {
        net.active = false;
        net.q = [];
    }
    Module.vcNet = null;
});
// clang-format on

static int RelayId = 0;
static double LastYield = 0;

UDPInterfaceClass::UDPInterfaceClass(void)
    : WinsockInterfaceClass()
{
}

UDPInterfaceClass::~UDPInterfaceClass(void)
{
    while (BroadcastAddresses.Count()) {
        delete[] BroadcastAddresses[0];
        BroadcastAddresses.Delete(0);
    }

    while (LocalAddresses.Count()) {
        delete[] LocalAddresses[0];
        LocalAddresses.Delete(0);
    }

    vcnet_close();
    RelayId = 0;
    Close();
}

void UDPInterfaceClass::Set_Broadcast_Address(void*)
{
    // Broadcasts always go to relay destination 0 (everyone else in the room).
}

bool UDPInterfaceClass::Open_Socket(SOCKET)
{
    if (!WinsockInitialised) {
        if (!Init())
            return (false);
    }

    // The page has already connected and joined a room; adopt that connection.
    RelayId = vcnet_open();
    if (RelayId == 0) {
        return (false);
    }

    while (LocalAddresses.Count()) {
        delete[] LocalAddresses[0];
        LocalAddresses.Delete(0);
    }
    unsigned char* a = new unsigned char[4];
    a[0] = 10;
    a[1] = 0;
    a[2] = 0;
    a[3] = (unsigned char)RelayId;
    LocalAddresses.Add(a);

    LastYield = emscripten_get_now();
    return (true);
}

void UDPInterfaceClass::Broadcast(void* buffer, int buffer_len)
{
    WinsockBufferType* packet = new WinsockBufferType;
    memcpy(packet->Buffer, buffer, buffer_len);
    packet->BufferLen = buffer_len;
    packet->IsBroadcast = true;
    memset(packet->Address, 0, sizeof(packet->Address));
    memset(packet->Address + 4, 255, 4);
    OutBuffers.Add(packet);

    Keyboard->Check();
}

int UDPInterfaceClass::Message_Handler()
{
    if (RelayId == 0) {
        return 0;
    }

    /*
    ** Send everything queued. A packet for 10.0.0.N goes to relay id N; anything else that is
    ** not a broadcast has no route and is dropped, as an undeliverable UDP packet would be.
    */
    while (OutBuffers.Count() != 0) {
        WinsockBufferType* packet = OutBuffers[0];
        const unsigned char* ip = packet->Address + 4;
        int dest = -1;
        if (packet->IsBroadcast) {
            dest = 0;
        } else if (ip[0] == 10 && ip[1] == 0 && ip[2] == 0 && ip[3] != 0 && ip[3] != 255) {
            dest = ip[3];
        }
        // Natively a packet sent to ourselves is received and then discarded; skip it here.
        if (dest >= 0 && dest != RelayId) {
            vcnet_send(dest, packet->Buffer, packet->BufferLen);
        }
        OutBuffers.Delete(0);
        delete packet;
    }

    /*
    ** Drain the receive queue. The relay never echoes our own broadcasts, which matches the
    ** native code discarding packets from LocalAddresses.
    */
    bool received = false;
    int rc;
    while ((rc = vcnet_recv(ReceiveBuffer, sizeof(ReceiveBuffer))) > 0) {
        int sender = ReceiveBuffer[0];
        if (sender == RelayId || sender == 0) {
            continue;
        }
        WinsockBufferType* packet = new WinsockBufferType;
        packet->BufferLen = rc - 1;
        packet->IsBroadcast = false;
        memcpy(packet->Buffer, ReceiveBuffer + 1, rc - 1);
        memset(packet->Address, 0, sizeof(packet->Address));
        packet->Address[4] = 10;
        packet->Address[5] = 0;
        packet->Address[6] = 0;
        packet->Address[7] = (unsigned char)sender;
        InBuffers.Add(packet);
        received = true;
    }

    /*
    ** Lobby code polls in tight loops that never return to the browser, so WebSocket messages
    ** could never arrive. When nothing was received and we have not yielded for 10 ms, give the
    ** browser a moment to run its event loop.
    */
    double now = emscripten_get_now();
    if (received) {
        LastYield = now;
    } else if (now - LastYield >= 10.0) {
        us_sleep(1000);
        LastYield = emscripten_get_now();
    }

    return 0;
}

#endif // NETWORKING

#endif // __EMSCRIPTEN__
