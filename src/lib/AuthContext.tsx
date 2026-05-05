import React, { createContext, useContext, useState, useEffect } from "react";
import { supabase } from "./supabase";

export type User = {
  id: string;
  username: string;
  discriminator?: string;
  avatar_url?: string;
  isAdmin?: boolean;
};

type AuthContextType = {
  user: User | null;
  login: () => void;
  logout: () => void;
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let hasEnsuredUser = false;

    const ensurePlayerExists = async (
      discordName: string,
      userId: string,
      avatarUrl?: string,
    ) => {
      if (hasEnsuredUser) return;
      hasEnsuredUser = true;

      try {
        // 1. Check if the player already exists in the database by user_id
        // We order by created_at or matches to pick their "Main" profile (the first one they had)
        const { data: userByIds, error: userByIdError } = await supabase
          .from("players")
          .select("user_id, name, is_admin")
          .eq("user_id", userId)
          .order("matches", { ascending: false })
          .limit(1);

        if (userByIdError && userByIdError.code !== "PGRST116") {
          console.error("Error checking player by id:", userByIdError);
        }

        if (userByIds && userByIds.length > 0) {
          const userById = userByIds[0];
          // Update the context with the saved name, rather than the Discord name
          setUser((prev) =>
            prev
              ? {
                  ...prev,
                  username: userById.name,
                  isAdmin: !!userById.is_admin,
                }
              : null,
          );

          if (avatarUrl) {
            // Silently try to update the avatar. If the column doesn't exist, it will just fail.
            supabase
              .from("players")
              .update({ avatar_url: avatarUrl })
              .eq("user_id", userId)
              .then(() => {});
          }
          return;
        }

        // 2. If not found by user_id, search by their Discord name to link an old profile
        let { data: userByNames, error: selectError } = await supabase
          .from("players")
          .select("user_id, name, is_admin")
          .ilike("name", discordName)
          .limit(1);

        if (selectError && selectError.code !== "PGRST116") {
          console.error("Error checking player by name:", selectError);
          return;
        }

        const userByName =
          userByNames && userByNames.length > 0 ? userByNames[0] : null;
        if (userByName && !userByName.user_id) {
          await supabase
            .from("players")
            .update({ user_id: userId })
            .eq("name", userByName.name);
          setUser((prev) =>
            prev
              ? {
                  ...prev,
                  username: userByName.name,
                  isAdmin: !!userByName.is_admin,
                }
              : null,
          );
          return;
        }

        let finalName = discordName;
        // If the name is already taken by someone else
        if (userByName && userByName.user_id && userByName.user_id !== userId) {
          finalName = `${discordName}_${Math.floor(Math.random() * 10000)}`;
        }

        // 4. If no data exists, insert a new placeholder profile
        const { error: insertError } = await supabase.from("players").insert([
          {
            name: finalName,
            user_id: userId,
            matches: 0,
            score: 0,
            deaths: 0,
            kdr: "-",
            accuracy: "-",
            kpm: "-",
            crouches: 0,
            time_in_lobby: 0,
            elo: "-",
            rank: 999999,
          },
        ]);

        if (insertError) {
          console.error("Error inserting player:", insertError);
        } else {
          setUser((prev) => (prev ? { ...prev, username: finalName } : null));
        }
      } catch (err) {
        console.error("Unexpected error ensuring player exists:", err);
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const username =
          session.user.user_metadata?.full_name ||
          session.user.user_metadata?.name ||
          "User";
        setUser((prev) => {
          if (prev && prev.id === session.user.id) return prev;
          return {
            id: session.user.id,
            username: username,
            avatar_url: session.user.user_metadata?.avatar_url,
          };
        });

        ensurePlayerExists(
          username,
          session.user.id,
          session.user.user_metadata?.avatar_url,
        );
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        const username =
          session.user.user_metadata?.full_name ||
          session.user.user_metadata?.name ||
          "User";
        setUser((prev) => {
          if (prev && prev.id === session.user.id) return prev;
          return {
            id: session.user.id,
            username: username,
            avatar_url: session.user.user_metadata?.avatar_url,
          };
        });

        ensurePlayerExists(
          username,
          session.user.id,
          session.user.user_metadata?.avatar_url,
        );
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const login = async () => {
    // Determine the redirect URL dynamically to support deployment properly
    const redirectTo = `${window.location.origin}${window.location.pathname}`;

    await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo,
      },
    });
  };

  const logout = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
