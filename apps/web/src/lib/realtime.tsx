import { useEffect } from "react";
import { io } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth";

export function RealtimeBridge() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!token) return;
    const socket = io({ auth: { token } });
    const invalidateLive = () => {
      queryClient.invalidateQueries({ queryKey: ["active-alerts"] });
      queryClient.invalidateQueries({ queryKey: ["floor"] });
      queryClient.invalidateQueries({ queryKey: ["operator-snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    };
    const invalidateAdmin = () => queryClient.invalidateQueries({ queryKey: ["admin"] });
    const invalidateChannels = () => {
      queryClient.invalidateQueries({ queryKey: ["channels"] });
      queryClient.invalidateQueries({ queryKey: ["channel-messages"] });
    };
    const invalidateChannelMessage = (payload: { channelId?: string | null; alertId?: string | null }) => {
      queryClient.invalidateQueries({ queryKey: ["channels"] });
      if (payload.channelId) {
        queryClient.invalidateQueries({ queryKey: ["channel-messages", payload.channelId] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["channel-messages"] });
      }
      if (payload.alertId) invalidateLive();
    };
    socket.on("alert.changed", invalidateLive);
    socket.on("command.changed", invalidateLive);
    socket.on("admin.changed", invalidateAdmin);
    socket.on("communication.message.created", invalidateChannelMessage);
    socket.on("communication.membership.changed", invalidateChannels);
    return () => {
      socket.disconnect();
    };
  }, [token, queryClient]);

  return null;
}
