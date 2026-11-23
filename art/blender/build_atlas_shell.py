"""
Builds the ATLAS floor-1 building shell in Blender and exports it to public/models/atlas/office-shell.glb.

Run inside Blender (Scripting tab, or the MCP `execute_blender_code` tool):
    exec(open(r"C:\\Users\\Strikeout\\Projects\\atlas\\art\\blender\\build_atlas_shell.py").read())

Coordinates mirror src/components/atlas-office/layout.ts. That file uses three.js axes
(x east, y up, z south); Blender is z-up, so a layout point (x, z) at height y becomes (x, -z, y) here.
Keep both files in sync when the floor plan changes.

Textures come from Downloaded-Models/textures (Poly Haven / ambientCG, CC0). They are scaled to
TEX_SIZE and packed before export, so the GLB stays small and the 4K sources are never shipped.
"""

import math
import os

import bmesh
import bpy
import numpy as np

import os
PROJECT = os.environ.get("ATLAS_PROJECT", r"C:\Users\Strikeout\Projects\atlas")
TEX = os.path.join(PROJECT, "Downloaded-Models", "textures")
# "director" is the Director's floor; "lower" is the floor below it, the same plan without the executive office.
# Headless: set ATLAS_SHELL_VARIANT=lower and run blender -b --factory-startup --python build_atlas_shell.py
VARIANT = os.environ.get("ATLAS_SHELL_VARIANT", "director")
assert VARIANT in ("director", "lower"), VARIANT
HAS_EXECUTIVE = VARIANT == "director"
OUT = os.path.join(
    PROJECT, "public", "models", "atlas", "office-shell.glb" if HAS_EXECUTIVE else "office-shell-lower.glb"
)
TEX_SIZE = 1024
COLLECTION = "ATLAS_Shell"

# --- Floor plan (mirror of layout.ts) -------------------------------------------------------
FLOOR = dict(minX=-11.5, maxX=11.5, minZ=-6.5, maxZ=6.5, ceiling=3.2)
# The executive office fills the south-west corner: solid west wall, window wall to the south, glass to the east
# and north, door in the north wall. Only the Director's floor has it.
EXEC = dict(minX=-11.5, maxX=-6.0, minZ=1.7, maxZ=6.5, doorX=-6.75)
CONF = dict(minX=-0.3, maxX=7.6, maxZ=-2.2, doorX=3.65)
DOOR = 1.2
ELEVATOR_X = 9.3
H = FLOOR["ceiling"]
W = FLOOR["maxX"] - FLOOR["minX"]
D = FLOOR["maxZ"] - FLOOR["minZ"]


# --- Scene helpers --------------------------------------------------------------------------
def fresh_collection(name):
    old = bpy.data.collections.get(name)
    if old:
        for obj in list(old.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(old)
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def box_uvs(bm, tile):
    """World-aligned box mapping so textures keep real-world scale on every face."""
    uv = bm.loops.layers.uv.verify()
    for face in bm.faces:
        n = face.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in face.loops:
            x, y, z = loop.vert.co
            if ax == 2:
                u, v = x, y
            elif ax == 0:
                u, v = y, z
            else:
                u, v = x, z
            loop[uv].uv = (u / tile, v / tile)


def box(col, name, x, z, w, d, h, y0, mat, tile=2.0):
    """Axis-aligned box from layout coordinates: centre (x, z), footprint w×d, height h from y0."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x = x + v.co.x * w
        v.co.y = -z + v.co.y * d
        v.co.z = y0 + h / 2 + v.co.z * h
    bm.normal_update()
    box_uvs(bm, tile)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    mesh.materials.append(mat)
    col.objects.link(obj)
    return obj


def disc(col, name, x, z, r, h, y0, mat, tile=2.0, segments=48):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r, radius2=r, depth=h)
    for v in bm.verts:
        v.co.x += x
        v.co.y += -z
        v.co.z += y0 + h / 2
    bm.normal_update()
    box_uvs(bm, tile)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    mesh.materials.append(mat)
    col.objects.link(obj)
    return obj


# --- Materials ------------------------------------------------------------------------------
_IMAGES = {}


def load_image(rel, colorspace="sRGB", tint=None, cap=None):
    """Loads, downsizes, optionally tints and packs a texture. Each (file, tint) pair gets its own image."""
    key = (rel, colorspace, tuple(tint) if tint else None, cap)
    if key in _IMAGES:
        return _IMAGES[key]
    path = os.path.join(TEX, rel)
    img = bpy.data.images.load(path, check_existing=False)
    stem = os.path.splitext(os.path.basename(rel))[0]
    img.name = f"atlas_{stem}" + ("_tinted" if tint else "")
    img.colorspace_settings.name = colorspace
    if max(img.size) > TEX_SIZE:
        img.scale(TEX_SIZE, TEX_SIZE)
    if tint is not None:
        px = np.empty(len(img.pixels), dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(-1, 4)
        px[:, :3] = np.clip(px[:, :3] * np.array(tint, dtype=np.float32), 0.0, cap if cap is not None else 1.0)
        img.pixels.foreach_set(px.ravel())
    img.pack()
    _IMAGES[key] = img
    return img


def material(name, color=None, normal=None, rough=None, metal=None, base=(0.8, 0.8, 0.8), roughness=0.6,
             metallic=0.0, emission=None, strength=1.0, alpha=1.0, color_tint=None, color_cap=None):
    old = bpy.data.materials.get(name)
    if old:
        bpy.data.materials.remove(old)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    x = -500
    if color:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = load_image(color, "sRGB", color_tint, color_cap)
        tex.location = (x, 300)
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if rough:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = load_image(rough, "Non-Color")
        tex.location = (x, 0)
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Roughness"])
    if metal:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = load_image(metal, "Non-Color")
        tex.location = (x, -150)
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Metallic"])
    if normal:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = load_image(normal, "Non-Color")
        tex.location = (x - 300, -350)
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.location = (x, -350)
        nt.links.new(tex.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.surface_render_method = "BLENDED"
    return mat


def srgb(hex_color):
    """Hex colour to linear RGB (Blender colour inputs are linear)."""
    hex_color = hex_color.lstrip("#")
    c = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def build_materials():
    m = {}
    m["floor"] = material(
        "ATLAS_FloorTiles",
        color="Tiles045_4K-PNG/Tiles045_4K-PNG_Color.png",
        normal="Tiles045_4K-PNG/Tiles045_4K-PNG_NormalGL.png",
        rough="Tiles045_4K-PNG/Tiles045_4K-PNG_Roughness.png",
        color_tint=(1.9, 1.95, 2.1),
        # Caps the light grout lines (linear value) so the floor reads as slate, not bathroom tile.
        color_cap=0.075,
    )
    m["wood"] = material(
        "ATLAS_WoodFloor",
        color="old_wooden_floor_03_4k/textures/old_wooden_floor_03_diff_4k.jpg",
        normal="old_wooden_floor_03_4k/textures/old_wooden_floor_03_nor_gl_4k.exr",
        roughness=0.5,
        color_tint=(0.85, 0.8, 0.78),
    )
    m["carpet"] = material(
        "ATLAS_Carpet",
        color="Carpet016_4K-PNG/Carpet016_4K-PNG_Color.png",
        normal="Carpet016_4K-PNG/Carpet016_4K-PNG_NormalGL.png",
        rough="Carpet016_4K-PNG/Carpet016_4K-PNG_Roughness.png",
    )
    m["backWall"] = material(
        "ATLAS_BackWall",
        color="concrete_tile_facade_4k/textures/concrete_tile_facade_diff_4k.jpg",
        normal="concrete_tile_facade_4k/textures/concrete_tile_facade_nor_gl_4k.exr",
        rough="concrete_tile_facade_4k/textures/concrete_tile_facade_rough_4k.exr",
    )
    m["plaster"] = material(
        "ATLAS_Plaster",
        color="plastered_wall_05_4k/textures/plastered_wall_05_diff_4k.jpg",
        normal="plastered_wall_05_4k/textures/plastered_wall_05_nor_gl_4k.exr",
        rough="plastered_wall_05_4k/textures/plastered_wall_05_rough_4k.exr",
    )
    m["ceiling"] = material(
        "ATLAS_Ceiling",
        normal="plastered_wall_05_4k/textures/plastered_wall_05_nor_gl_4k.exr",
        base=srgb("#e4dfd6"),
        roughness=0.9,
    )
    m["frame"] = material(
        "ATLAS_FrameMetal",
        color="Metal055A_2K-PNG/Metal055A_2K-PNG_Color.png",
        normal="Metal055A_2K-PNG/Metal055A_2K-PNG_NormalGL.png",
        rough="Metal055A_2K-PNG/Metal055A_2K-PNG_Roughness.png",
        metallic=0.85,
        color_tint=(0.16, 0.17, 0.19),
    )
    m["steel"] = material(
        "ATLAS_Steel",
        color="Metal055A_2K-PNG/Metal055A_2K-PNG_Color.png",
        normal="Metal055A_2K-PNG/Metal055A_2K-PNG_NormalGL.png",
        rough="Metal055A_2K-PNG/Metal055A_2K-PNG_Roughness.png",
        metallic=1.0,
    )
    m["neon"] = material("ATLAS_NeonCyan", base=(0.0, 0.0, 0.0), emission=srgb("#38d7ff"), strength=6.0)
    m["amber"] = material("ATLAS_NeonAmber", base=(0.0, 0.0, 0.0), emission=srgb("#ffb347"), strength=4.0)
    m["panel"] = material("ATLAS_LightPanel", base=srgb("#fff7ea"), emission=srgb("#fff1dc"), strength=3.0)
    m["glass"] = material("ATLAS_Glass", base=srgb("#bcd9e6"), roughness=0.05, alpha=0.15)
    m["dark"] = material("ATLAS_DarkTrim", base=srgb("#15181b"), roughness=0.45)
    return m


# --- Building ---------------------------------------------------------------------------------
def glass_wall(col, m, name, x, z, w, d, neon=False):
    """A floor-to-ceiling glass pane with metal channels, posts and optional neon strips."""
    box(col, f"Glass_{name}", x, z, w, d, H - 0.1, 0.05, m["glass"])
    along_x = w > d
    length = w if along_x else d
    thick = 0.1
    fw, fd = (w, thick) if along_x else (thick, d)
    box(col, f"Frame_{name}_Base", x, z, fw, fd, 0.05, 0.0, m["frame"], tile=1.0)
    box(col, f"Frame_{name}_Head", x, z, fw, fd, 0.08, H - 0.08, m["frame"], tile=1.0)
    posts = max(1, round(length / 1.4))
    for i in range(posts + 1):
        t = -length / 2 + i * length / posts
        px, pz = (x + t, z) if along_x else (x, z + t)
        box(col, f"Frame_{name}_Post{i}", px, pz, 0.05, 0.05, H, 0.0, m["frame"], tile=1.0)
    if neon:
        for y in (0.055, 2.45):
            nx, nz = (x, z + 0.06) if along_x else (x + 0.06, z)
            nw, nd = (w, 0.03) if along_x else (0.03, d)
            box(col, f"Neon_{name}_{int(y * 100)}", nx, nz, nw, nd, 0.03, y, m["neon"], tile=1.0)


def front_wall(col, m, name, room, z=None):
    """The room's glass wall with the door, running east-west at z (the room's south edge unless given)."""
    z = room["maxZ"] if z is None else z
    west, east = room["doorX"] - DOOR / 2, room["doorX"] + DOOR / 2
    glass_wall(col, m, f"{name}FrontWest", (room["minX"] + west) / 2, z, west - room["minX"], 0.04, neon=True)
    glass_wall(col, m, f"{name}FrontEast", (east + room["maxX"]) / 2, z, room["maxX"] - east, 0.04, neon=True)
    # Glass transom above the doorway, framed.
    box(col, f"Glass_{name}Transom", room["doorX"], z, DOOR, 0.04, H - 2.4, 2.35, m["glass"])
    box(col, f"Frame_{name}DoorHead", room["doorX"], z, DOOR + 0.1, 0.1, 0.06, 2.3, m["frame"], tile=1.0)


def build():
    col = fresh_collection(COLLECTION)
    m = build_materials()

    # Floors and rugs
    box(col, "Floor_Main", 0, 0, W + 0.4, D + 0.4, 0.2, -0.2, m["floor"], tile=3.0)
    rooms = [("Conference", dict(CONF, minZ=FLOOR["minZ"]))]
    if HAS_EXECUTIVE:
        rooms.append(("Executive", EXEC))
    for name, room in rooms:
        cx = (room["minX"] + room["maxX"]) / 2
        cz = (room["minZ"] + room["maxZ"]) / 2
        box(col, f"Floor_{name}", cx, cz, room["maxX"] - room["minX"], room["maxZ"] - room["minZ"], 0.006, 0.0,
            m["wood"], tile=1.6)
    rugs = [
        ("Rug_Conference", 3.65, -4.4, 5.6, 2.9),
        ("Rug_Lounge", 0.0, 3.1, 4.4, 2.2),
        ("Rug_Foosball", -7.8, -4.4, 2.3, 1.6),
    ]
    if HAS_EXECUTIVE:
        # Under the guest armchairs and visitors, and under the pool table where the old office stood.
        rugs += [("Rug_Executive", -7.7, 4.1, 2.6, 2.6), ("Rug_Pool", -2.85, -4.5, 3.8, 2.6)]
    else:
        # Downstairs the pool table's corner is a lounge nook (LOWER_NOOK in layout.ts) with its own rug.
        rugs += [("Rug_Nook", -2.85, -4.75, 3.6, 2.9)]
    for name, x, z, w, d in rugs:
        box(col, name, x, z, w, d, 0.012, 0.006, m["carpet"], tile=1.5)
    disc(col, "Rug_Beanbags", 6.4, 3.2, 1.35, 0.012, 0.006, m["carpet"], tile=1.5)

    # Outer walls, baseboards, ceiling
    box(col, "Wall_Back", 0, FLOOR["minZ"] - 0.1, W + 0.4, 0.2, H, 0, m["backWall"], tile=2.4)
    box(col, "Wall_West", FLOOR["minX"] - 0.1, 0, 0.2, D + 0.4, H, 0, m["plaster"], tile=3.0)
    box(col, "Wall_East", FLOOR["maxX"] + 0.1, 0, 0.2, D + 0.4, H, 0, m["plaster"], tile=3.0)
    box(col, "Base_Back", 0, FLOOR["minZ"] + 0.01, W, 0.02, 0.1, 0, m["dark"])
    box(col, "Base_West", FLOOR["minX"] + 0.01, 0, 0.02, D, 0.1, 0, m["dark"])
    box(col, "Base_East", FLOOR["maxX"] - 0.01, 0, 0.02, D, 0.1, 0, m["dark"])
    box(col, "Ceiling", 0, 0, W + 0.4, D + 0.4, 0.1, H, m["ceiling"], tile=3.0)
    panels = [(x, 0.4) for x in (-8, -4, 0, 4, 8)] + [(x, 4.6) for x in (-8, -4, 0, 4, 8)]
    panels += [(-2.85, -4.2), (3.65, -4.4), (-8.0, -4.4), (9.3, -4.2), (-10.0, 0.0)]
    for i, (x, z) in enumerate(panels):
        box(col, f"LightPanel_{i}", x, z, 1.6, 0.35, 0.02, H - 0.02, m["panel"])
    for i, x in enumerate((-8.6, 7.9, 10.9)):
        box(col, f"Neon_WallStrip_{i}", x, FLOOR["minZ"] + 0.02, 0.08, 0.04, 2.6, 0.3, m["amber"])

    # Window wall: floor-to-ceiling glass with dark mullions
    wz = FLOOR["maxZ"] + 0.05
    box(col, "Glass_Window", 0, wz, W, 0.02, H, 0, m["glass"])
    box(col, "Frame_Window_Sill", 0, wz, W, 0.18, 0.12, 0, m["frame"], tile=1.0)
    box(col, "Frame_Window_Head", 0, wz, W, 0.18, 0.3, H - 0.3, m["frame"], tile=1.0)
    for i in range(13):
        x = FLOOR["minX"] + i * W / 12
        box(col, f"Frame_Window_Mullion{i}", x, wz, 0.08, 0.14, H, 0, m["frame"], tile=1.0)

    # Glass rooms
    room_depth = CONF["maxZ"] - FLOOR["minZ"]
    room_cz = (CONF["maxZ"] + FLOOR["minZ"]) / 2
    glass_wall(col, m, "ConferenceWest", CONF["minX"], room_cz, 0.04, room_depth)
    glass_wall(col, m, "ConferenceEast", CONF["maxX"], room_cz, 0.04, room_depth)
    front_wall(col, m, "Conference", CONF)
    if HAS_EXECUTIVE:
        exec_depth = EXEC["maxZ"] - EXEC["minZ"]
        glass_wall(col, m, "ExecutiveEast", EXEC["maxX"], (EXEC["minZ"] + EXEC["maxZ"]) / 2, 0.04, exec_depth)
        front_wall(col, m, "Executive", EXEC, z=EXEC["minZ"])

    # Elevator on the back wall
    ez = FLOOR["minZ"]
    box(col, "Elevator_Portal", ELEVATOR_X, ez + 0.03, 2.3, 0.06, 2.55, 0, m["dark"])
    for i, offset in enumerate((-0.48, 0.48)):
        box(col, f"Elevator_Door{i}", ELEVATOR_X + offset, ez + 0.08, 0.92, 0.04, 2.25, 0.02, m["steel"], tile=1.0)
    box(col, "Elevator_Display", ELEVATOR_X, ez + 0.07, 0.5, 0.02, 0.12, 2.38, m["amber"])
    box(col, "Elevator_CallPanel", ELEVATOR_X + 1.35, ez + 0.05, 0.12, 0.03, 0.28, 1.06, m["amber"])
    return col


def merge_by_material(col):
    """One mesh per material keeps draw calls low in the browser (glass stays separate by material)."""
    groups = {}
    for obj in list(col.objects):
        groups.setdefault(obj.active_material.name, []).append(obj)
    for name, objs in groups.items():
        if len(objs) < 2:
            objs[0].name = name.replace("ATLAS_", "Shell_")
            continue
        with bpy.context.temp_override(
            active_object=objs[0], selected_editable_objects=objs, selected_objects=objs
        ):
            bpy.ops.object.join()
        objs[0].name = name.replace("ATLAS_", "Shell_")


def export(col):
    merge_by_material(col)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    for obj in bpy.context.scene.objects:
        obj.select_set(False)
    for obj in col.objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = col.objects[0]
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        use_selection=True,
        use_active_scene=True,  # without this, objects selected in other scenes (the Director) come along
        export_apply=True,
        export_yup=True,
        export_image_format="WEBP",
        export_image_quality=82,
        export_materials="EXPORT",
        export_lights=False,
        export_extras=False,
    )
    return os.path.getsize(OUT)


shell = build()
size = export(shell)
if HAS_EXECUTIVE:
    # Only the Director's floor is saved: a headless lower-floor run starts from an empty scene and must never
    # overwrite the working file.
    BLEND = os.path.join(PROJECT, "art", "blender", "atlas_floor1.blend")
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, copy=True)
result = {"objects": len(shell.objects), "names": sorted(o.name for o in shell.objects), "glb_bytes": size, "path": OUT}
